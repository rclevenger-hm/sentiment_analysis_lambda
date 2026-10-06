'use strict';

const { randomUUID } = require('node:crypto');
const { HttpError, invalid, hash, header, decodeBody, parseJson, parseBulk, validateText, tenantFrom } = require('./input');
const { filtersFrom, filterResults, summarize, compare, csvExport, validateRule } = require('./insights');
const { final } = require('./store');

function publicJob(job) {
  return { jobId: job.jobId, label: job.label, status: job.status, createdAt: job.createdAt,
    updatedAt: job.updatedAt, total: job.total, processed: job.offset,
    progress: job.total ? Math.round(job.offset / job.total * 100) : 0,
    targeted: job.targeted, summary: job.summary, failureReason: job.failureReason,
    expiresAt: new Date(job.expiresAt * 1000).toISOString() };
}
function numberParam(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max) throw invalid(`Expected an integer between ${min} and ${max}`);
  return Number(value);
}
function jobId(value) { if (!/^[a-f0-9]{64}$/.test(value || '')) throw invalid('Invalid job id'); return value; }

function createHandler({ store, analyzer, clock = () => new Date(), logger = console }) {
  return async function handler(event = {}, context = {}) {
    const requestId = event.requestContext?.requestId || context.awsRequestId || randomUUID();
    const headers = {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': process.env.ALLOWED_ORIGIN || '*',
      'access-control-expose-headers': 'x-request-id,Retry-After,Content-Disposition',
      'x-request-id': requestId,
    };
    const response = (statusCode, body, extra = {}) => {
      const encoded = typeof body === 'string' ? body : JSON.stringify(body);
      if (Buffer.byteLength(encoded) > 5 * 1024 * 1024) throw new HttpError(413, 'RESULT_TOO_LARGE', 'Reduce the result limit or use the export endpoint');
      return { statusCode, headers: { ...headers, ...extra }, body: encoded };
    };
    const started = Date.now(); let statusCode = 500;
    try {
      const tenantId = tenantFrom(event);
      const method = event.httpMethod || event.requestContext?.http?.method;
      const path = (event.path || '/analyze-sentiment').replace(/\/$/, '');
      const query = event.queryStringParameters || {};
      let result;
      if (method === 'POST' && path === '/analyze-sentiment') {
        const payload = parseJson(decodeBody(event)); const record = validateText(payload);
        const targeted = payload.targeted === undefined ? false : payload.targeted;
        if (typeof targeted !== 'boolean' || (targeted && record.languageCode !== 'en')) throw invalid('targeted must be boolean and is supported for English only');
        await store.reserveUsage(tenantId, targeted ? 2 : 1);
        try { result = response(200, await analyzer.single(record, targeted)); }
        catch { throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Sentiment service unavailable'); }
      } else if (method === 'POST' && path === '/jobs') {
        const key = header(event, 'idempotency-key');
        if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw invalid('Idempotency-Key must contain 8–128 letters, numbers, dots, underscores, colons, or hyphens');
        const payload = parseBulk(event); const id = hash(key); const fingerprint = hash(JSON.stringify(payload));
        let existing = await store.get(tenantId, `JOB#${id}`);
        if (!existing) {
          const units = payload.records.filter((record) => !record.error).length * (payload.targeted ? 2 : 1);
          const usage = await store.usage(tenantId);
          if (usage.units + units > usage.limit) throw new HttpError(429, 'DAILY_LIMIT_EXCEEDED', 'Daily analysis allowance exceeded; resets at 00:00 UTC');
          const inputKey = `${tenantId}/jobs/${id}/input-${fingerprint}.json`;
          await store.putObject(inputKey, payload);
          const time = clock().toISOString();
          const job = { tenantId, key: `JOB#${id}`, jobId: id, fingerprint, inputKey,
            collectionId: `${tenantId}#jobs`, createdAt: time, updatedAt: time, expiresAt: store.expiry(),
            status: 'QUEUED', offset: 0, total: payload.records.length, targeted: payload.targeted, label: payload.label };
          existing = (await store.createJob(job, units)).job;
        }
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different data');
        if (!final(existing.status)) await store.enqueue(tenantId, id);
        result = response(final(existing.status) ? 200 : 202, publicJob(existing), { location: `/jobs/${id}` });
      } else if (method === 'GET' && path === '/history') {
        const filters = filtersFrom(query);
        const page = await store.list(tenantId, 'jobs', { ...filters, limit: numberParam(query.limit, 20, 1, 100), cursor: query.cursor });
        if (query.status && !['QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(query.status)) throw invalid('Invalid status filter');
        result = response(200, { jobs: page.items.filter((job) => !query.status || job.status === query.status).map(publicJob), nextCursor: page.nextCursor });
      } else if (method === 'GET' && path === '/usage') result = response(200, await store.usage(tenantId));
      else if (method === 'GET' && path === '/alert-rule') result = response(200, (await store.get(tenantId, 'RULE#default'))?.rule || { enabled: false, minRecords: 5, negativeRate: 0.5, filters: {} });
      else if (method === 'PUT' && path === '/alert-rule') {
        const rule = validateRule(parseJson(decodeBody(event))); await store.putRule(tenantId, rule); result = response(200, rule);
      } else if (method === 'GET' && path === '/alerts') {
        const page = await store.list(tenantId, 'alerts', { limit: numberParam(query.limit, 20, 1, 100), cursor: query.cursor });
        result = response(200, { alerts: page.items.map((item) => ({ jobId: item.jobId, createdAt: item.createdAt, acknowledged: item.acknowledged, ...item.alert })), nextCursor: page.nextCursor });
      } else if (method === 'PUT' && /^\/alerts\/[^/]+\/acknowledge$/.test(path)) {
        await store.acknowledge(tenantId, jobId(path.split('/')[2])); result = response(200, { acknowledged: true });
      } else if (method === 'GET' && path === '/compare') {
        const current = await store.getJob(tenantId, jobId(query.current)); const baseline = await store.getJob(tenantId, jobId(query.baseline));
        if (!final(current.status) || !final(baseline.status)) throw new HttpError(409, 'JOB_NOT_FINISHED', 'Both jobs must finish before comparison');
        const filters = filtersFrom(query);
        const report = async (job) => summarize(filterResults(await store.results(job), filters, job.createdAt.slice(0, 10)), job.createdAt.slice(0, 10));
        result = response(200, { currentJobId: current.jobId, baselineJobId: baseline.jobId, ...compare(await report(current), await report(baseline)) });
      } else if (method === 'GET' && /^\/jobs\/[^/]+(?:\/(results|report|export))?$/.test(path)) {
        const parts = path.split('/'); const job = await store.getJob(tenantId, jobId(parts[2]));
        if (!parts[3]) result = response(200, publicJob(job));
        else {
          const records = filterResults(await store.results(job), filtersFrom(query), job.createdAt.slice(0, 10));
          if (parts[3] === 'report') result = response(200, { job: publicJob(job), ...summarize(records, job.createdAt.slice(0, 10)) });
          else if (parts[3] === 'export') {
            if (!final(job.status)) throw new HttpError(409, 'JOB_NOT_FINISHED', 'Wait until the job finishes before exporting');
            const format = query.format || 'json'; if (!['json', 'csv'].includes(format)) throw invalid('format must be csv or json');
            const content = format === 'csv' ? csvExport(records) : JSON.stringify({ job: publicJob(job), records });
            const exportKey = `${tenantId}/jobs/${job.jobId}/exports/${hash(content)}.${format}`;
            const downloadUrl = await store.exportFile(exportKey, content, format);
            result = response(200, { downloadUrl, expiresInSeconds: 60, recordCount: records.length, format });
          } else {
            const offset = numberParam(query.offset, 0, 0, 200); const limit = numberParam(query.limit, 50, 1, 100);
            result = response(200, { job: publicJob(job), totalMatched: records.length, records: records.slice(offset, offset + limit), nextOffset: offset + limit < records.length ? offset + limit : null });
          }
        }
      } else throw new HttpError(404, 'NOT_FOUND', 'Route not found');
      statusCode = result.statusCode; return result;
    } catch (error) {
      const known = error instanceof HttpError;
      statusCode = known ? error.status : 503;
      logger.error(JSON.stringify({ event: 'request_error', requestId, code: known ? error.code : 'SERVICE_UNAVAILABLE', errorName: error.name }));
      return response(statusCode, { error: known ? error.message : 'Service temporarily unavailable', code: known ? error.code : 'SERVICE_UNAVAILABLE', requestId }, statusCode === 429 ? { 'retry-after': String(Math.ceil((Date.parse(clock().toISOString().slice(0, 10)) + 86400000 - clock().getTime()) / 1000)) } : {});
    } finally {
      logger.info(JSON.stringify({ event: 'request_complete', requestId, statusCode, durationMs: Date.now() - started }));
    }
  };
}
let runtime;
async function analyzeSentiment(event, context) {
  if (!runtime) runtime = createHandler({ store: require('./store').createStore(), analyzer: require('./analyzer').createAnalyzer() });
  return runtime(event, context);
}
module.exports = { createHandler, analyzeSentiment, publicJob };
