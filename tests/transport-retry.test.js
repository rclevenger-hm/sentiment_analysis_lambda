'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyzer, transient } = require('../lambda_function/analyzer');
const { tenantFrom } = require('../lambda_function/input');
const { fixture, event } = require('./helpers');

const record = { id: 'one', text: 'good product', languageCode: 'en' };
const good = { Index: 0, Sentiment: 'POSITIVE', SentimentScore: { Positive: 0.99, Negative: 0.01, Neutral: 0, Mixed: 0 } };
const networkError = (code = 'ECONNREFUSED') => Object.assign(new Error('Private transport details'), { code });

test('transient transport codes are recognized independently of an Error name', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
    const error = networkError(code);
    assert.equal(error.name, 'Error');
    assert.equal(transient(error), true, code);
  }
});

test('transport code handling preserves existing named and HTTP error classification', () => {
  assert.equal(transient({ code: 'ECONNREFUSED' }), true);
  assert.equal(transient({ name: 'ThrottlingException', code: 'OTHER' }), true);
  assert.equal(transient({ name: 'TimeoutError', code: 'OTHER' }), true);
  assert.equal(transient({ name: 'Error', $metadata: { httpStatusCode: 503 } }), true);
  assert.equal(transient({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }), false);
  assert.equal(transient({ name: 'InvalidRequestException', code: 'INVALID_REQUEST', $metadata: { httpStatusCode: 400 } }), false);
  assert.equal(transient({ name: 'Error', $metadata: { httpStatusCode: 429 } }), false);
  assert.equal(transient(networkError('EINVAL')), false);
  assert.equal(transient(new Error('ECONNREFUSED is only part of the message')), false);
  assert.equal(transient(undefined), false);
  assert.equal(transient(null), false);
});

for (const targeted of [false, true]) {
  test(`${targeted ? 'targeted' : 'overall'} analysis rethrows a coded transport failure and can succeed on retry`, async () => {
    const error = networkError();
    let fail = true;
    const analyzer = createAnalyzer({ send: async (command) => {
      const detail = command.constructor.name === 'BatchDetectTargetedSentimentCommand';
      if (fail && detail === targeted) { fail = false; throw error; }
      return detail ? { ResultList: [{ Index: 0, Entities: [] }] } : { ResultList: [good] };
    } });
    await assert.rejects(analyzer.batch([record], targeted), (actual) => actual === error);
    const [result] = await analyzer.batch([record], targeted);
    assert.equal(result.sentiment, 'POSITIVE');
    assert.equal(result.error, undefined);
    assert.equal(result.insightsError, undefined);
    if (targeted) assert.deepEqual(result.entities, []);
  });

  test(`worker preserves a checkpoint on ${targeted ? 'targeted' : 'overall'} transport failure and completes after redelivery`, async () => {
    const f = fixture();
    const request = event('POST', '/jobs', { records: [record], targeted });
    const { jobId } = JSON.parse((await f.api(request)).body);
    const tenantId = tenantFrom(request);
    let fail = true;
    const analyzer = createAnalyzer({ send: async (command) => {
      const detail = command.constructor.name === 'BatchDetectTargetedSentimentCommand';
      if (fail && detail === targeted) { fail = false; throw networkError(); }
      return detail ? { ResultList: [{ Index: 0, Entities: [] }] } : { ResultList: [good] };
    } });
    f.analyzer.batch = analyzer.batch;
    assert.deepEqual(await f.tick(), { batchItemFailures: [{ itemIdentifier: 'msg' }] });
    const job = await f.store.getJob(tenantId, jobId);
    assert.equal(job.offset, 0);
    assert.equal(job.status, 'RUNNING');
    assert.equal([...f.objects.keys()].some((key) => /\/part-\d+\.json$/.test(key)), false);

    // The in-memory fixture does not model time. Release its lease to model
    // redelivery after the production store's lease expires.
    delete f.items.get(`${tenantId}:JOB#${jobId}`).leaseToken;
    await f.store.enqueue(tenantId, jobId);
    assert.deepEqual(await f.tick(), { batchItemFailures: [] });
    const completed = await f.store.getJob(tenantId, jobId);
    assert.equal(completed.offset, 1);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.summary.failed, 0);
    assert.equal(completed.summary.insightFailures, 0);
    const [result] = await f.store.results(completed);
    assert.equal(result.sentiment, 'POSITIVE');
    assert.equal(result.error, undefined);
    assert.equal(result.insightsError, undefined);
  });
}
