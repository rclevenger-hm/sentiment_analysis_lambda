'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../lambda_function/store');
const { createWorker } = require('../lambda_function/worker');

const tenantId = 'a'.repeat(64);
const jobId = 'b'.repeat(64);
const now = new Date('2026-11-07T00:00:00Z');
const seconds = now.getTime() / 1000;
const config = { TABLE_NAME: 'table', DATA_BUCKET: 'bucket', QUEUE_URL: 'queue' };
const conditional = () => Object.assign(new Error('Condition did not match'), { name: 'ConditionalCheckFailedException' });
const logger = { info() {}, error() {} };
function useDeadLetterQueue(t) {
  const previous = process.env.DLQ_ARN;
  process.env.DLQ_ARN = 'arn:aws:sqs:us-east-1:123456789012:failed';
  t.after(() => {
    if (previous === undefined) delete process.env.DLQ_ARN;
    else process.env.DLQ_ARN = previous;
  });
}

// Model DynamoDB's conditional update at write time, including a checkpoint
// that commits after a caller has decided to attempt a terminal transition.
function failureStore(job) {
  const calls = [];
  const store = createStore({ config, clock: () => now, s3: {}, sqs: {}, db: {
    async send(command) {
      calls.push(command);
      const { ConditionExpression: condition, ExpressionAttributeValues: values } = command.input;
      if (values[':offset'] !== undefined) {
        assert.match(condition, /leaseToken = :token AND #offset = :previous/);
        assert.match(command.input.UpdateExpression, /REMOVE leaseToken, leaseUntil, attempts/);
        if (job.leaseToken !== values[':token'] || job.offset !== values[':previous']) throw conditional();
        Object.assign(job, { offset: values[':offset'], status: values[':status'], summary: values[':summary'] });
        delete job.leaseToken;
        delete job.leaseUntil;
        delete job.attempts;
        return {};
      }
      assert.match(condition, /attempts >= :max/);
      assert.match(condition, /#status = :queued OR #status = :running/);
      assert.match(condition, /attribute_not_exists\(leaseUntil\) OR leaseUntil < :now/);
      assert.equal(values[':max'], 5);
      assert.equal(values[':now'], seconds);
      assert.deepEqual(command.input.Key, { tenantId, key: `JOB#${jobId}` });
      if (!job || !['QUEUED', 'RUNNING'].includes(job.status)
        || !(job.attempts >= values[':max'])
        || (job.leaseUntil !== undefined && !(job.leaseUntil < values[':now']))) throw conditional();
      job.status = values[':failed'];
      delete job.leaseToken;
      delete job.leaseUntil;
      return {};
    },
  } });
  return { store, calls };
}

for (const [name, initial] of [
  ['a new queued job', { status: 'QUEUED', offset: 0 }],
  ['a successfully checkpointed job', { status: 'QUEUED', offset: 125 }],
  ['an explicitly zeroed retry count', { status: 'QUEUED', offset: 25, attempts: 0 }],
  ['a retryable expired claim', { status: 'RUNNING', offset: 25, attempts: 4, leaseUntil: seconds - 1 }],
  ['a worker still holding its last lease', { status: 'RUNNING', attempts: 5, leaseUntil: seconds + 1, leaseToken: 'owner' }],
  ['a lease at its expiry boundary', { status: 'RUNNING', attempts: 5, leaseUntil: seconds, leaseToken: 'owner' }],
  ['a completed job', { status: 'COMPLETED', attempts: 5 }],
  ['a completed job with errors', { status: 'COMPLETED_WITH_ERRORS', attempts: 5 }],
  ['an already failed job', { status: 'FAILED', attempts: 5 }],
  ['missing metadata', null],
]) {
  test(`dead-letter failure cannot replace ${name}`, async () => {
    const job = structuredClone(initial);
    const { store, calls } = failureStore(job);
    await store.fail(tenantId, jobId);
    assert.deepEqual(job, initial);
    assert.equal(calls.length, 1, 'the guard must be in the atomic update, without a separate pre-read');
  });
}

for (const status of ['QUEUED', 'RUNNING']) {
  test(`exhausted ${status.toLowerCase()} jobs still fail without an active lease`, async () => {
    const job = { status, offset: 25, attempts: 5, ...(status === 'RUNNING' ? { leaseUntil: seconds - 1, leaseToken: 'expired' } : {}) };
    const { store } = failureStore(job);
    await store.fail(tenantId, jobId);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.offset, 25);
    assert.equal(job.leaseToken, undefined);
    assert.equal(job.leaseUntil, undefined);
  });
}

test('dead-letter handler acknowledges stale delivery without running inference or changing progress', async (t) => {
  useDeadLetterQueue(t);
  const job = { status: 'QUEUED', offset: 125 };
  const { store, calls } = failureStore(job);
  const worker = createWorker({ store, analyzer: { batch: async () => assert.fail('Dead letters must not run inference') }, logger });
  const result = await worker({ Records: [{ messageId: 'stale', eventSourceARN: process.env.DLQ_ARN, body: JSON.stringify({ tenantId, jobId }) }] });
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(job, { status: 'QUEUED', offset: 125 });
  assert.equal(calls.length, 1);
});

test('dead-letter handler keeps a database outage retryable', async (t) => {
  useDeadLetterQueue(t);
  const store = createStore({ config, clock: () => now, s3: {}, sqs: {}, db: { send: async () => {
    throw Object.assign(new Error('Unavailable'), { name: 'InternalServerError' });
  } } });
  const worker = createWorker({ store, analyzer: {}, logger });
  const result = await worker({ Records: [{ messageId: 'retry', eventSourceARN: process.env.DLQ_ARN, body: JSON.stringify({ tenantId, jobId }) }] });
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'retry' }] });
});


test('checkpointed chunks survive repeated enqueue failures and stale dead-letter delivery', async (t) => {
  useDeadLetterQueue(t);
  const records = Array.from({ length: 126 }, (_, i) => ({ id: String(i), text: 'good', languageCode: 'en' }));
  const job = { tenantId, jobId, key: `JOB#${jobId}`, inputKey: 'input', status: 'QUEUED', offset: 0, total: records.length, createdAt: now.toISOString() };
  const { store } = failureStore(job);
  const parts = new Map();
  let inferenceCount = 0;
  let queueUnavailable = true;
  // Only transport and claim acquisition are substituted. Checkpoint and
  // terminal-failure writes use the production store and conditional stub.
  store.claim = async () => {
    if (job.status !== 'QUEUED') return null;
    job.status = 'RUNNING'; job.leaseToken = 'current'; job.attempts = (job.attempts || 0) + 1;
    return structuredClone(job);
  };
  store.getObject = async () => ({ records });
  store.putObject = async (key, rows) => parts.set(key, structuredClone(rows));
  store.results = async (checkpoint) => [...parts.entries()].filter(([key]) => Number(key.match(/part-(\d+)\.json$/)[1]) < checkpoint.offset).flatMap(([, rows]) => rows);
  store.get = async () => null;
  store.enqueue = async () => { if (queueUnavailable) throw new Error('Queue unavailable'); };
  const worker = createWorker({ store, logger, analyzer: { batch: async (rows) => {
    inferenceCount += rows.length;
    return rows.map((row) => ({ ...row, sentiment: 'POSITIVE' }));
  } } });
  const delivery = { messageId: 'original', body: JSON.stringify({ tenantId, jobId }) };
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.deepEqual(await worker({ Records: [delivery] }), { batchItemFailures: [{ itemIdentifier: 'original' }] });
    assert.equal(job.offset, attempt * 25);
    assert.equal(job.status, 'QUEUED');
    assert.equal(job.attempts, undefined);
  }
  const savedChunks = structuredClone([...parts]);
  assert.deepEqual(await worker({ Records: [{ ...delivery, eventSourceARN: process.env.DLQ_ARN }] }), { batchItemFailures: [] });
  assert.equal(job.status, 'QUEUED');
  assert.equal(job.offset, 125);
  assert.deepEqual([...parts], savedChunks);

  // Model a later delivery requeued by the scheduled recovery sweep.
  queueUnavailable = false;
  assert.deepEqual(await worker({ Records: [{ ...delivery, messageId: 'recovered' }] }), { batchItemFailures: [] });
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.offset, 126);
  assert.equal(job.summary.analyzed, 126);
  assert.equal(inferenceCount, 126, 'checkpointed records must not incur repeated inference');
});


test('a checkpoint racing the exhaustion read prevents the later terminal write', async () => {
  const job = { status: 'RUNNING', offset: 0, attempts: 5, leaseUntil: seconds - 1, expiresAt: seconds + 3600 };
  const { store: terminalStore } = failureStore(job);
  const store = createStore({ config, clock: () => now, s3: {}, sqs: {}, db: { send: async (command) => {
    if (command.constructor.name === 'GetCommand') {
      const exhausted = structuredClone(job);
      // Another worker checkpoints after this read but before fail's write.
      job.status = 'QUEUED'; job.offset = 25;
      delete job.attempts; delete job.leaseUntil;
      return { Item: exhausted };
    }
    assert.match(command.input.UpdateExpression, /attempts = if_not_exists/);
    throw conditional();
  } } });
  store.fail = terminalStore.fail;
  assert.equal(await store.claim(tenantId, jobId), null);
  assert.equal(job.status, 'QUEUED');
  assert.equal(job.offset, 25);
  assert.equal(job.attempts, undefined);
});
