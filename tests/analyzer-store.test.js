'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyzer } = require('../lambda_function/analyzer');
const { createStore } = require('../lambda_function/store');
const good = (Index = 0) => ({ Index, Sentiment: 'POSITIVE', SentimentScore: { Positive: 0.99, Negative: 0.01, Neutral: 0, Mixed: 0 } });

test('analyzer groups languages and preserves per-document errors and original ids', async () => {
  const calls = [];
  const analyzer = createAnalyzer({ send: async (command) => {
    calls.push(command.input);
    return command.input.LanguageCode === 'en' ? { ResultList: [good(0)], ErrorList: [{ Index: 1, ErrorCode: 'INVALID_REQUEST' }] } : { ResultList: [good(0)] };
  } });
  const results = await analyzer.batch([{ id: 'a', text: 'good', languageCode: 'en' }, { id: 'b', text: 'broken', languageCode: 'en' }, { id: 'c', text: 'bueno', languageCode: 'es' }, { id: 'd', error: { code: 'INVALID' } }]);
  assert.equal(calls.length, 2); assert.equal(results[0].sentiment, 'POSITIVE'); assert.equal(results[1].error.code, 'INVALID_REQUEST'); assert.equal(results[2].id, 'c'); assert.equal(results[3].error.code, 'INVALID');
});
test('transient batch and per-item failures are retried rather than saved as final failures', async () => {
  const records = [{ id: 'a', text: 'test', languageCode: 'en' }];
  const analyzer = createAnalyzer({ send: async () => { throw Object.assign(new Error(), { name: 'ThrottlingException' }); } });
  await assert.rejects(analyzer.batch(records), { name: 'ThrottlingException' });
  const perItem = createAnalyzer({ send: async () => ({ ErrorList: [{ Index: 0, ErrorCode: 'INTERNAL_SERVER_ERROR' }] }) });
  await assert.rejects(perItem.batch(records), { name: 'INTERNAL_SERVER_ERROR' });
});
test('targeted failures retain overall sentiment and declare partial insights', async () => {
  const analyzer = createAnalyzer({ send: async (command) => command.constructor.name === 'BatchDetectSentimentCommand' ? { ResultList: [good()] } : { ErrorList: [{ Index: 0, ErrorCode: 'INVALID_REQUEST' }] } });
  const result = await analyzer.batch([{ id: 'a', text: 'good', languageCode: 'en' }], true);
  assert.equal(result[0].sentiment, 'POSITIVE'); assert.equal(result[0].insightsError.code, 'INVALID_REQUEST');
});
test('missing upstream result is an explicit record failure, not a false success', async () => {
  const result = await createAnalyzer({ send: async () => ({ ResultList: [] }) }).batch([{ id: 'a', text: 'good', languageCode: 'en' }]);
  assert.ok(result[0].error); assert.equal(result[0].sentiment, undefined);
});
const config = { TABLE_NAME: 'table', DATA_BUCKET: 'bucket', QUEUE_URL: 'queue', DAILY_ANALYSIS_LIMIT: '10' };
const clock = () => new Date('2026-10-06T00:00:00Z');
function mocked(respond) { const calls = []; const store = createStore({ config, clock, db: { send: async (command) => { calls.push(command); return respond(command); } }, s3: {}, sqs: {} }); return { store, calls }; }
test('job creation atomically combines deduplication and quota reservation', async () => {
  const { store, calls } = mocked(() => ({}));
  await store.createJob({ tenantId: 'alice', key: 'JOB#one' }, 4);
  const request = calls[0].input;
  assert.equal(calls[0].constructor.name, 'TransactWriteCommand');
  assert.equal(request.TransactItems.length, 2);
  assert.match(request.TransactItems[0].Put.ConditionExpression, /attribute_not_exists/);
  assert.equal(request.TransactItems[1].Update.Key.tenantId, 'alice');
  assert.equal(request.TransactItems[1].Update.ExpressionAttributeValues[':remaining'], 6);
});
test('quota denial is a 429 and backend failures are not misreported as quota failures', async () => {
  const denied = mocked(() => { throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }); });
  await assert.rejects(denied.store.reserveUsage('alice', 1), (e) => e.status === 429);
  const outage = mocked(() => { throw Object.assign(new Error(), { name: 'InternalServerError' }); });
  await assert.rejects(outage.store.reserveUsage('alice', 1), { name: 'InternalServerError' });
});
test('expired job metadata is inaccessible even before DynamoDB TTL removes it', async () => {
  const { store } = mocked(() => ({ Item: { expiresAt: 1 } }));
  await assert.rejects(store.getJob('alice', 'one'), (e) => e.status === 404);
});
test('history cursor cannot be replayed against another principal or collection', async () => {
  const { store, calls } = mocked(() => ({}));
  const cursor = Buffer.from(JSON.stringify({ tenantId: 'bob', key: 'JOB#one', collectionId: 'bob#jobs', createdAt: clock().toISOString() })).toString('base64url');
  await assert.rejects(store.list('alice', 'jobs', { cursor }), (e) => e.status === 400); assert.equal(calls.length, 0);
});
test('claims use expiring leases and persistent attempt limits; checkpoints require the lease token', async () => {
  const { store, calls } = mocked(() => ({ Attributes: {} }));
  await store.claim('alice', 'one');
  assert.match(calls[0].input.ConditionExpression, /leaseUntil < :now/);
  assert.match(calls[0].input.ConditionExpression, /attempts < :max/);
  await store.checkpoint({ tenantId: 'alice', key: 'JOB#one', offset: 0, leaseToken: 'owner' }, 25);
  assert.match(calls[1].input.ConditionExpression, /leaseToken = :token/);
  assert.match(calls[1].input.UpdateExpression, /REMOVE leaseToken, leaseUntil, attempts/);
});
test('exhausted attempts mark a stalled job failed rather than looping forever', async () => {
  const { store, calls } = mocked((command) => {
    if (command.constructor.name === 'GetCommand') return { Item: { status: 'RUNNING', attempts: 5, leaseUntil: 1, expiresAt: 9999999999 } };
    if (command.input.UpdateExpression.includes('if_not_exists')) throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' });
    return {};
  });
  assert.equal(await store.claim('alice', 'one'), null);
  assert.equal(calls.at(-1).input.ExpressionAttributeValues[':failed'], 'FAILED');
});
