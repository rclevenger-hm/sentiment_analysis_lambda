'use strict';

const { summarize, evaluateRule } = require('./insights');

function createWorker({ store, analyzer, logger = console }) {
  async function processJob(tenantId, jobId) {
    const job = await store.claim(tenantId, jobId);
    if (!job) return;
    const input = await store.getObject(job.inputKey);
    const records = input.records.slice(job.offset, job.offset + 25);
    const results = await analyzer.batch(records, job.targeted);
    await store.putObject(`${tenantId}/jobs/${jobId}/part-${job.offset}.json`, results);
    const offset = job.offset + records.length;
    let summary;
    if (offset === job.total) {
      const complete = [...await store.results(job), ...results];
      summary = summarize(complete, job.createdAt.slice(0, 10));
      const rule = (await store.get(tenantId, 'RULE#default'))?.rule;
      const alert = evaluateRule(rule, complete, job.createdAt.slice(0, 10));
      if (alert) await store.putAlert(job, alert);
    }
    await store.checkpoint(job, offset, summary);
    // A failed send is retried by SQS. Recovery also requeues stranded checkpoints.
    if (!summary) await store.enqueue(tenantId, jobId);
    logger.info(JSON.stringify({ event: 'job_progress', jobId, processed: offset, total: job.total }));
  }
  return async function worker(event, context = {}) {
    if (event.source === 'aws.events') {
      let cursor;
      do { cursor = await store.recover(cursor); }
      while (cursor && (!context.getRemainingTimeInMillis || context.getRemainingTimeInMillis() > 15000));
      if (cursor) throw new Error('Recovery scan did not finish; increase recovery timeout/capacity');
      return;
    }
    const batchItemFailures = [];
    for (const record of event.Records || []) {
      try {
        const { tenantId, jobId } = JSON.parse(record.body);
        if (!/^[a-f0-9]{64}$/.test(tenantId) || !/^[a-f0-9]{64}$/.test(jobId)) throw new Error('Invalid queue message');
        if (process.env.DLQ_ARN && record.eventSourceARN === process.env.DLQ_ARN) await store.fail(tenantId, jobId);
        else await processJob(tenantId, jobId);
      } catch (error) {
        logger.error(JSON.stringify({ event: 'worker_error', messageId: record.messageId, errorName: error.name }));
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
let runtime;
async function handler(event, context) {
  if (!runtime) runtime = createWorker({ store: require('./store').createStore(), analyzer: require('./analyzer').createAnalyzer() });
  return runtime(event, context);
}
module.exports = { createWorker, handler };
