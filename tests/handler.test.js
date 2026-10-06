'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, event } = require('./helpers');
const { tenantFrom } = require('../lambda_function/input');
const parsed = (response) => JSON.parse(response.body);

test('single analysis authenticates, meters, preserves the response contract and correlation', async () => {
  const f = fixture(); const request = event('POST', '/analyze-sentiment', { text: 'good' });
  const response = await f.api(request);
  assert.equal(response.statusCode, 200); assert.equal(parsed(response).sentiment, 'POSITIVE');
  assert.equal(response.headers['x-request-id'], 'request-123');
  assert.match(response.headers['access-control-expose-headers'], /x-request-id/);
  assert.equal((await f.store.usage(tenantFrom(request))).units, 1);
});
for (const [body, expected] of [['null', 400], ['[]', 400], ['123', 400], ['{bad', 400], [{ text: 'x', languageCode: false }, 400], [{ text: 'x', languageCode: null }, 400], [{ text: '😀'.repeat(1251) }, 413]]) {
  test(`invalid request ${JSON.stringify(body).slice(0, 70)} receives a controlled error`, async () => {
    const f = fixture(); const response = await f.api(event('POST', '/analyze-sentiment', body));
    assert.equal(response.statusCode, expected); assert.ok(parsed(response).code); assert.equal(f.calls.length, 0);
  });
}
test('base64 JSON is decoded and UTF-8 byte limits are respected', async () => {
  const f = fixture(); const request = event('POST', '/analyze-sentiment', Buffer.from(JSON.stringify({ text: '😀'.repeat(1250) })).toString('base64'), { isBase64Encoded: true });
  assert.equal((await f.api(request)).statusCode, 200);
  assert.equal((await f.api({ ...request, body: 'invalid=base64' })).statusCode, 400);
  assert.equal((await f.api({ ...request, body: Buffer.from([0xff]).toString('base64') })).statusCode, 400);
});
test('authentication fails before parsing or metering and caller headers cannot choose another tenant', async () => {
  const f = fixture(); const response = await f.api(event('POST', '/analyze-sentiment', '{bad', { requestContext: {}, headers: { 'x-tenant-id': 'alice' } }));
  assert.equal(response.statusCode, 401); assert.equal(f.calls.length, 0); assert.equal(f.items.size, 0);
});
test('errors and success telemetry do not log submitted text or upstream secret details', async () => {
  const f = fixture(); f.analyzer.single = async () => { throw new Error('sensitive internal details'); };
  const response = await f.api(event('POST', '/analyze-sentiment', { text: 'private customer feedback' }));
  assert.equal(response.statusCode, 502);
  assert.doesNotMatch(JSON.stringify(f.logs) + response.body, /private customer|sensitive internal/);
});
test('parallel duplicate submissions reserve one allowance and reject reused keys with changed data', async () => {
  const f = fixture(); const request = event('POST', '/jobs', { records: [{ id: 'one', text: 'good' }] });
  const responses = await Promise.all([f.api(request), f.api(request)]);
  assert.deepEqual(responses.map((r) => r.statusCode), [202, 202]);
  assert.equal(parsed(responses[0]).jobId, parsed(responses[1]).jobId);
  assert.equal((await f.store.usage(tenantFrom(request))).units, 1);
  assert.equal((await f.api(event('POST', '/jobs', { records: [{ text: 'different' }] }))).statusCode, 409);
});
test('daily units are charged for targeted operations and block excess before inference', async () => {
  const f = fixture(2);
  assert.equal((await f.api(event('POST', '/analyze-sentiment', { text: 'good', targeted: true }))).statusCode, 200);
  const blocked = await f.api(event('POST', '/analyze-sentiment', { text: 'good' }));
  assert.equal(blocked.statusCode, 429); assert.ok(Number(blocked.headers['retry-after']) > 0); assert.equal(f.calls.length, 1);
});
test('bulk jobs preserve ids and partial failures across checkpoints, history, reports and export', async () => {
  const f = fixture();
  const records = Array.from({ length: 28 }, (_, i) => ({ id: `row-${i}`, text: i % 2 ? 'bad delivery' : 'good product', product: 'widget', date: '2026-10-01' }));
  records[27].text = '';
  const submission = parsed(await f.api(event('POST', '/jobs', { records, label: 'October' })));
  assert.equal(submission.processed, 0);
  await f.tick();
  let status = parsed(await f.api(event('GET', `/jobs/${submission.jobId}`)));
  assert.equal(status.processed, 25); assert.equal(status.status, 'QUEUED');
  await f.tick();
  status = parsed(await f.api(event('GET', `/jobs/${submission.jobId}`)));
  assert.equal(status.processed, 28); assert.equal(status.status, 'COMPLETED_WITH_ERRORS');
  assert.equal(status.summary.failed, 1); assert.equal(f.calls.length, 27);
  const results = parsed(await f.api(event('GET', `/jobs/${submission.jobId}/results`)));
  assert.equal(results.records[27].id, 'row-27'); assert.ok(results.records[27].error);
  const report = parsed(await f.api(event('GET', `/jobs/${submission.jobId}/report`, undefined, { queryStringParameters: { sentiment: 'NEGATIVE', product: 'widget' } })));
  assert.equal(report.total, 13); assert.equal(report.negativeRate, 1); assert.equal(report.trends[0].date, '2026-10-01');
  const exported = parsed(await f.api(event('GET', `/jobs/${submission.jobId}/export`, undefined, { queryStringParameters: { format: 'csv' } })));
  assert.equal(exported.recordCount, 28); assert.equal(exported.expiresInSeconds, 60);
  assert.match([...f.objects.values()].find((v) => typeof v === 'string'), /row-27/);
  assert.equal(parsed(await f.api(event('GET', '/history'))).jobs.length, 1);
  // Duplicate delivery after completion must not make more billable calls.
  await f.worker({ Records: [{ messageId: 'again', body: JSON.stringify({ tenantId: tenantFrom(event('GET', '/')), jobId: submission.jobId }) }] });
  assert.equal(f.calls.length, 27);
});
test('job reads, exports, comparison and alert acknowledgement enforce caller isolation', async () => {
  const f = fixture(); const job = parsed(await f.api(event('POST', '/jobs', { records: [{ text: 'good' }] })));
  await f.tick();
  const other = { requestContext: { identity: { userArn: 'arn:aws:iam::123456789012:user/bob', caller: 'AIDABOB', accountId: '123456789012' } } };
  for (const path of [`/jobs/${job.jobId}`, `/jobs/${job.jobId}/export`, `/jobs/${job.jobId}/report`]) assert.equal((await f.api(event('GET', path, undefined, other))).statusCode, 404);
  assert.equal(parsed(await f.api(event('GET', '/history', undefined, other))).jobs.length, 0);
  assert.equal((await f.api(event('PUT', `/alerts/${job.jobId}/acknowledge`, undefined, other))).statusCode, 404);
  assert.equal((await f.api(event('GET', '/compare', undefined, { ...other, queryStringParameters: { current: job.jobId, baseline: job.jobId } }))).statusCode, 404);
});
test('configurable alert rules link threshold breaches to original record ids and support acknowledgement', async () => {
  const f = fixture();
  assert.equal((await f.api(event('PUT', '/alert-rule', { enabled: true, minRecords: 2, negativeRate: 0.5, filters: { source: 'support' } }))).statusCode, 200);
  const job = parsed(await f.api(event('POST', '/jobs', { records: [{ id: 'ticket-1', text: 'bad', source: 'support' }, { id: 'ticket-2', text: 'bad', source: 'support' }, { id: 'review', text: 'good', source: 'reviews' }] })));
  await f.tick(); const alerts = parsed(await f.api(event('GET', '/alerts'))).alerts;
  assert.equal(alerts.length, 1); assert.deepEqual(alerts[0].evidenceRecordIds, ['ticket-1', 'ticket-2']);
  assert.equal((await f.api(event('PUT', `/alerts/${job.jobId}/acknowledge`))).statusCode, 200);
  assert.equal(parsed(await f.api(event('GET', '/alerts'))).alerts[0].acknowledged, true);
});
test('comparison reports sample rates with a stable baseline and handles in-progress jobs', async () => {
  const f = fixture();
  const a = parsed(await f.api(event('POST', '/jobs', { records: [{ text: 'good' }] })));
  assert.equal((await f.api(event('GET', '/compare', undefined, { queryStringParameters: { current: a.jobId, baseline: a.jobId } }))).statusCode, 409);
  await f.tick();
  const b = parsed(await f.api(event('POST', '/jobs', { records: [{ text: 'bad' }] }, { headers: { 'idempotency-key': 'another-key-123' } })));
  await f.tick();
  const response = parsed(await f.api(event('GET', '/compare', undefined, { queryStringParameters: { current: b.jobId, baseline: a.jobId } })));
  assert.equal(response.negativeRateChange, 1); assert.match(response.note, /statistical significance/);
});
test('worker failures return SQS partial failures without advancing a checkpoint', async () => {
  const f = fixture(); const job = parsed(await f.api(event('POST', '/jobs', { records: [{ text: 'good' }] })));
  f.analyzer.batch = async () => { throw Object.assign(new Error('upstream unavailable'), { name: 'ThrottlingException' }); };
  assert.deepEqual(await f.tick(), { batchItemFailures: [{ itemIdentifier: 'msg' }] });
  assert.equal((await f.store.getJob(tenantFrom(event('GET', '/')), job.jobId)).offset, 0);
});
test('unsupported media type and duplicate ids are rejected before reserving usage', async () => {
  const f = fixture();
  const a = await f.api(event('POST', '/jobs', 'hello', { headers: { 'content-type': 'application/octet-stream', 'idempotency-key': 'test-key-1234' } }));
  assert.equal(a.statusCode, 415);
  const b = await f.api(event('POST', '/jobs', { records: [{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }] }));
  assert.equal(b.statusCode, 400); assert.equal(f.items.size, 0);
});

test('a duplicate racing with the last available quota unit still returns its existing job', async () => {
  const f = fixture(1); const request = event('POST', '/jobs', { records: [{ text: 'good' }] });
  const first = parsed(await f.api(request)); const originalGet = f.store.get.bind(f.store);
  let reads = 0;
  f.store.get = async (tenant, key) => key.startsWith('JOB#') && reads++ === 0 ? null : originalGet(tenant, key);
  const duplicate = await f.api(request);
  assert.equal(duplicate.statusCode, 202); assert.equal(parsed(duplicate).jobId, first.jobId);
  assert.equal((await f.store.usage(tenantFrom(request))).units, 1);
});
