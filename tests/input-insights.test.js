'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, parseBulk, tenantFrom, dateOnly, decodeBody } = require('../lambda_function/input');
const { csvExport, summarize, targetedEntities, evaluateRule, filtersFrom } = require('../lambda_function/insights');
const { event } = require('./helpers');

test('CSV parser accepts quoted commas, escaped quotes, CRLF, BOM and embedded newlines', () => {
  const rows = parseCsv('\uFEFFid,text,source\r\none,"Great, but ""late""\nagain",reviews\r\n');
  assert.deepEqual(rows, [{ id: 'one', text: 'Great, but "late"\nagain', source: 'reviews' }]);
});
for (const csv of ['text,text\na,b', 'id\na', 'text\n"unclosed', 'text\n"closed"oops', 'text\na,b']) test(`reject malformed CSV ${csv}`, () => assert.throws(() => parseCsv(csv)));
test('bulk validation keeps invalid rows and assigns deterministic missing ids', () => {
  const result = parseBulk(event('POST', '/jobs', { targeted: true, records: [{ text: 'fine' }, null, { id: 'spanish', text: 'hola', languageCode: 'es' }] }));
  assert.equal(result.records[0].id, 'row-1'); assert.ok(result.records[1].error); assert.ok(result.records[2].error);
});
test('oversized encoded request is rejected before decoding', () => assert.throws(() => decodeBody({ body: 'a'.repeat(2 * 1024 * 1024), isBase64Encoded: true }), (e) => e.status === 413));
test('calendar dates and report filter ranges are validated', () => {
  assert.throws(() => dateOnly('2026-02-30')); assert.equal(dateOnly('2024-02-29'), '2024-02-29');
  assert.throws(() => filtersFrom({ from: '2026-10-02', to: '2026-10-01' })); assert.throws(() => filtersFrom({ minConfidence: 'nonsense' }));
});
test('STS sessions share a role tenant and different roles remain isolated', () => {
  const identity = (session, caller) => ({ requestContext: { identity: { userArn: `arn:aws:sts::123456789012:assumed-role/customer/${session}`, caller, accountId: '123456789012' } } });
  assert.equal(tenantFrom(identity('first', 'AROACUSTOMER:first')), tenantFrom(identity('second', 'AROACUSTOMER:second')));
  assert.notEqual(tenantFrom(identity('first', 'AROACUSTOMER:first')), tenantFrom(identity('first', 'AROAOTHER:first')));
});
test('exports preserve quotes/newlines and neutralize spreadsheet formulas', () => {
  const csv = csvExport([{ id: '=HYPERLINK("x")', text: '\t=CMD()', source: 'plain', product: 'quoted "widget"' }]);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/); assert.match(csv, /"'\t=CMD\(\)"/); assert.match(csv, /quoted ""widget""/);
});
test('targeted sentiment includes source offsets and excerpts, bounded without inventing reasons', () => {
  const text = '😀 Product good; delivery bad';
  const entities = targetedEntities([{ Mentions: [{ Text: 'delivery', BeginOffset: 16, EndOffset: 24, Type: 'OTHER', MentionSentiment: { Sentiment: 'NEGATIVE' } }] }], text);
  assert.equal(entities[0].mentions[0].beginOffset, 16); assert.match(entities[0].mentions[0].excerpt, /delivery bad/);
  const summary = summarize([{ id: 'review-7', text, sentiment: 'MIXED', entities }], '2026-10-01');
  assert.equal(summary.concerns[0].negative, 1); assert.equal(summary.concerns[0].evidence[0].recordId, 'review-7');
});
test('empty successful samples do not manufacture rates or trigger alerts', () => {
  assert.equal(summarize([{ id: 'x', error: {} }], '2026-10-01').negativeRate, null);
  assert.equal(evaluateRule({ enabled: true, minRecords: 1, negativeRate: 0, filters: {} }, [{ id: 'x', error: {} }], '2026-10-01'), null);
});
