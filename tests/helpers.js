'use strict';
const { HttpError } = require('../lambda_function/input');
const { createHandler } = require('../lambda_function/handler');
const { createWorker } = require('../lambda_function/worker');
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const date = new Date('2026-10-06T00:00:00Z');
function fixture(limit = 1000) {
  const items = new Map(); const objects = new Map(); const queue = []; const calls = []; const logs = [];
  const pk = (tenant, key) => `${tenant}:${key}`;
  const store = {
    expiry: () => date.getTime() / 1000 + 30 * 86400,
    async get(t, k) { return clone(items.get(pk(t, k))) || null; },
    async getJob(t, id) { const v = await this.get(t, `JOB#${id}`); if (!v) throw new HttpError(404, 'NOT_FOUND', 'Resource not found'); return v; },
    async putObject(k, v) { objects.set(k, clone(v)); },
    async getObject(k) { if (!objects.has(k)) throw new Error('Object absent'); return clone(objects.get(k)); },
    async reserveUsage(t, units) { const old = items.get(pk(t, 'usage')) || 0; if (old + units > limit) throw new HttpError(429, 'DAILY_LIMIT_EXCEEDED', 'Quota exceeded'); items.set(pk(t, 'usage'), old + units); },
    async createJob(job, units) { const old = items.get(pk(job.tenantId, job.key)); if (old) return { job: clone(old), created: false }; const used = items.get(pk(job.tenantId, 'usage')) || 0; if (used + units > limit) throw new HttpError(429, 'DAILY_LIMIT_EXCEEDED', 'Quota exceeded'); items.set(pk(job.tenantId, 'usage'), used + units); items.set(pk(job.tenantId, job.key), clone(job)); return { job, created: true }; },
    async enqueue(tenantId, jobId) { queue.push({ tenantId, jobId }); },
    async claim(t, id) { const j = items.get(pk(t, `JOB#${id}`)); if (!j || j.leaseToken || !['QUEUED', 'RUNNING'].includes(j.status)) return null; j.leaseToken = 'lease'; j.status = 'RUNNING'; return clone(j); },
    async checkpoint(job, offset, summary) { const j = items.get(pk(job.tenantId, job.key)); if (j.leaseToken !== job.leaseToken) throw new Error('Lease lost'); j.offset = offset; j.status = summary ? (summary.failed || summary.insightFailures ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : 'QUEUED'; j.summary = summary; delete j.leaseToken; },
    async results(job) { const rows = []; for (let i = 0; i < job.offset; i += 25) rows.push(...await this.getObject(`${job.tenantId}/jobs/${job.jobId}/part-${i}.json`)); return rows; },
    async list(t, collection) { return { items: [...items.values()].filter((v) => v?.collectionId === `${t}#${collection}`).map(clone), nextCursor: null }; },
    async putRule(t, rule) { items.set(pk(t, 'RULE#default'), { rule: clone(rule) }); },
    async putAlert(job, alert) { const key = pk(job.tenantId, `ALERT#${job.jobId}`); if (!items.has(key)) items.set(key, { collectionId: `${job.tenantId}#alerts`, jobId: job.jobId, alert: clone(alert), acknowledged: false, createdAt: date.toISOString() }); },
    async acknowledge(t, id) { const a = items.get(pk(t, `ALERT#${id}`)); if (!a) throw new HttpError(404, 'NOT_FOUND', 'Not found'); a.acknowledged = true; },
    async usage(t) { return { units: items.get(pk(t, 'usage')) || 0, limit }; },
    async exportFile(key, content) { objects.set(key, content); return 'https://downloads.example/results'; },
    async recover() { return undefined; },
    async fail(t, id) { items.get(pk(t, `JOB#${id}`)).status = 'FAILED'; },
  };
  const analyze = (record) => ({ sentiment: record.text.includes('bad') ? 'NEGATIVE' : 'POSITIVE', sentimentScore: { Positive: record.text.includes('bad') ? 0.01 : 0.99, Negative: record.text.includes('bad') ? 0.99 : 0.01, Neutral: 0, Mixed: 0 } });
  const analyzer = { async single(record) { calls.push(record); return analyze(record); }, async batch(records) { calls.push(...records.filter((r) => !r.error)); return records.map((r) => r.error ? r : { ...r, ...analyze(r) }); } };
  const logger = { info: (line) => logs.push(line), error: (line) => logs.push(line) };
  const api = createHandler({ store, analyzer, clock: () => date, logger });
  const worker = createWorker({ store, analyzer, logger });
  const tick = async () => { const msg = queue.shift(); if (!msg) return; return worker({ Records: [{ messageId: 'msg', body: JSON.stringify(msg) }] }); };
  return { items, objects, queue, calls, logs, store, analyzer, api, worker, tick, date };
}
function event(method, path, body, other = {}) {
  return { httpMethod: method, path, headers: { 'content-type': 'application/json', 'idempotency-key': 'test-key-12345678' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: { requestId: 'request-123', identity: { userArn: 'arn:aws:iam::123456789012:user/alice', accountId: '123456789012', caller: 'AIDAALICE' } }, ...other };
}
module.exports = { fixture, event };
