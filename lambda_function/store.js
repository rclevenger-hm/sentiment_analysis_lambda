'use strict';

const { randomUUID } = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { HttpError, invalid } = require('./input');

const final = (status) => ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(status);
const conditional = (error) => error.name === 'ConditionalCheckFailedException';

function createStore({ db, s3, sqs, config = process.env, clock = () => new Date() } = {}) {
  db ||= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  s3 ||= new S3Client({}); sqs ||= new SQSClient({});
  const table = config.TABLE_NAME; const bucket = config.DATA_BUCKET;
  const retention = Number(config.DATA_RETENTION_DAYS || 30);
  const quota = Number(config.DAILY_ANALYSIS_LIMIT || 1000);
  const expiry = () => Math.floor(clock().getTime() / 1000) + retention * 86400;
  const key = (tenantId, id) => ({ tenantId, key: id });
  const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resource not found');
  const quotaError = () => new HttpError(429, 'DAILY_LIMIT_EXCEEDED', 'Daily analysis allowance exceeded; resets at 00:00 UTC');
  const usageUpdate = (tenantId, units) => ({
    TableName: table, Key: key(tenantId, `USAGE#${clock().toISOString().slice(0, 10)}`),
    UpdateExpression: 'SET expiresAt = :expires ADD units :units',
    ConditionExpression: 'attribute_not_exists(units) OR units <= :remaining',
    ExpressionAttributeValues: { ':units': units, ':remaining': quota - units, ':expires': Math.floor(clock().getTime() / 1000) + 3 * 86400 },
  });
  const store = {
    expiry,
    async putObject(path, value) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: path, Body: JSON.stringify(value), ContentType: 'application/json', ServerSideEncryption: 'AES256' }));
    },
    async exportFile(path, content, format) {
      const type = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json';
      const disposition = `attachment; filename="sentiment-results.${format}"`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: path, Body: content, ContentType: type, ContentDisposition: disposition, ServerSideEncryption: 'AES256' }));
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: path }), { expiresIn: 60 });
    },
    async getObject(path) {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: path }));
      return JSON.parse(await response.Body.transformToString());
    },
    async get(tenantId, id) {
      const { Item } = await db.send(new GetCommand({ TableName: table, Key: key(tenantId, id), ConsistentRead: true }));
      return Item && (!Item.expiresAt || Item.expiresAt > Math.floor(clock().getTime() / 1000)) ? Item : null;
    },
    async getJob(tenantId, jobId) { const job = await store.get(tenantId, `JOB#${jobId}`); if (!job) throw notFound(); return job; },
    async reserveUsage(tenantId, units) {
      if (units > quota) throw quotaError();
      try { await db.send(new UpdateCommand(usageUpdate(tenantId, units))); }
      catch (error) { if (conditional(error)) throw quotaError(); throw error; }
    },
    async createJob(job, units) {
      if (units > quota) throw quotaError();
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: table, Item: job, ConditionExpression: 'attribute_not_exists(#key)', ExpressionAttributeNames: { '#key': 'key' } } },
          { Update: usageUpdate(job.tenantId, units) },
        ] }));
        return { job, created: true };
      } catch (error) {
        if (error.name !== 'TransactionCanceledException') throw error;
        const existing = await store.get(job.tenantId, job.key);
        if (existing) return { job: existing, created: false };
        if (error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') throw quotaError();
        if (error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') throw new HttpError(409, 'EXPIRED_KEY', 'Use a new Idempotency-Key for this submission');
        throw error;
      }
    },
    async enqueue(tenantId, jobId) {
      await sqs.send(new SendMessageCommand({ QueueUrl: config.QUEUE_URL, MessageBody: JSON.stringify({ tenantId, jobId }) }));
    },
    async claim(tenantId, jobId) {
      const now = Math.floor(clock().getTime() / 1000); const token = randomUUID();
      try {
        const { Attributes } = await db.send(new UpdateCommand({ TableName: table, Key: key(tenantId, `JOB#${jobId}`),
          UpdateExpression: 'SET leaseToken = :token, leaseUntil = :lease, #status = :running, updatedAt = :time, attempts = if_not_exists(attempts, :zero) + :one',
          ConditionExpression: 'expiresAt > :now AND (#status = :queued OR #status = :running) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND (attribute_not_exists(attempts) OR attempts < :max)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':max': 5, ':token': token, ':lease': now + 180, ':now': now, ':time': clock().toISOString(), ':queued': 'QUEUED', ':running': 'RUNNING' },
          ReturnValues: 'ALL_NEW' }));
        return Attributes;
      } catch (error) {
        if (!conditional(error)) throw error;
        const job = await store.get(tenantId, `JOB#${jobId}`);
        if (job && !final(job.status) && job.attempts >= 5 && (!job.leaseUntil || job.leaseUntil < now)) await store.fail(tenantId, jobId);
        return null;
      }
    },
    async checkpoint(job, offset, summary) {
      const status = summary ? (summary.failed || summary.insightFailures ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED') : 'QUEUED';
      await db.send(new UpdateCommand({ TableName: table, Key: key(job.tenantId, job.key),
        UpdateExpression: `SET #offset = :offset, #status = :status, updatedAt = :time${summary ? ', summary = :summary' : ''} REMOVE leaseToken, leaseUntil, attempts`,
        ConditionExpression: 'leaseToken = :token AND #offset = :previous',
        ExpressionAttributeNames: { '#offset': 'offset', '#status': 'status' },
        ExpressionAttributeValues: { ':offset': offset, ':status': status, ':time': clock().toISOString(), ':token': job.leaseToken, ':previous': job.offset, ...(summary ? { ':summary': summary } : {}) } }));
    },
    async fail(tenantId, jobId) {
      try {
        await db.send(new UpdateCommand({ TableName: table, Key: key(tenantId, `JOB#${jobId}`),
          UpdateExpression: 'SET #status = :failed, failureReason = :reason, updatedAt = :time REMOVE leaseToken, leaseUntil',
          ConditionExpression: '(#status = :queued OR #status = :running) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'FAILED', ':reason': 'Worker retry limit exceeded. Completed records remain available.', ':queued': 'QUEUED', ':running': 'RUNNING', ':time': clock().toISOString(), ':now': Math.floor(clock().getTime() / 1000) } }));
      } catch (error) { if (!conditional(error)) throw error; }
    },
    async results(job) {
      const chunks = [];
      for (let offset = 0; offset < job.offset; offset += 25) chunks.push(await store.getObject(`${job.tenantId}/jobs/${job.jobId}/part-${offset}.json`));
      const records = chunks.flat();
      if (job.status === 'FAILED' && job.offset < job.total) {
        const input = await store.getObject(job.inputKey);
        records.push(...input.records.slice(job.offset).map((record) => ({ ...record, error: record.error || { code: 'JOB_FAILED', message: 'Worker retry limit exceeded before this record completed' } })));
      }
      return records;
    },
    async list(tenantId, collection, { limit = 20, cursor, from, to } = {}) {
      const collectionId = `${tenantId}#${collection}`;
      let start;
      if (cursor) {
        try { start = JSON.parse(Buffer.from(cursor, 'base64url').toString()); }
        catch { throw invalid('Invalid cursor'); }
        if (cursor.length > 2048 || start?.tenantId !== tenantId || start?.collectionId !== collectionId || typeof start.key !== 'string' || typeof start.createdAt !== 'string') throw invalid('Invalid cursor');
      }
      const names = { '#collection': 'collectionId' };
      const values = { ':collection': collectionId, ':from': from ? `${from}T00:00:00.000Z` : '0000', ':to': to ? `${to}T23:59:59.999Z` : '9999' };
      const result = await db.send(new QueryCommand({ TableName: table, IndexName: 'timeline',
        KeyConditionExpression: '#collection = :collection AND createdAt BETWEEN :from AND :to',
        ExpressionAttributeNames: names, ScanIndexForward: false,
        FilterExpression: 'expiresAt > :now',
        // Include expired rows in pagination accounting while excluding them from responses.
        Limit: limit, ExclusiveStartKey: start,
        ExpressionAttributeValues: { ...values, ':now': Math.floor(clock().getTime() / 1000) } }));
      return { items: result.Items || [], nextCursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : null };
    },
    async putRule(tenantId, rule) {
      await db.send(new PutCommand({ TableName: table, Item: { ...key(tenantId, 'RULE#default'), rule } }));
    },
    async putAlert(job, alert) {
      try {
        await db.send(new PutCommand({ TableName: table, Item: { ...key(job.tenantId, `ALERT#${job.jobId}`),
          collectionId: `${job.tenantId}#alerts`, createdAt: clock().toISOString(), expiresAt: job.expiresAt,
          jobId: job.jobId, alert, acknowledged: false }, ConditionExpression: 'attribute_not_exists(#key)', ExpressionAttributeNames: { '#key': 'key' } }));
      } catch (error) { if (!conditional(error)) throw error; }
    },
    async acknowledge(tenantId, jobId) {
      try { await db.send(new UpdateCommand({ TableName: table, Key: key(tenantId, `ALERT#${jobId}`),
        UpdateExpression: 'SET acknowledged = :yes', ConditionExpression: 'expiresAt > :now',
        ExpressionAttributeValues: { ':yes': true, ':now': Math.floor(clock().getTime() / 1000) } })); }
      catch (error) { if (conditional(error)) throw notFound(); throw error; }
    },
    async usage(tenantId) {
      const date = clock().toISOString().slice(0, 10); const item = await store.get(tenantId, `USAGE#${date}`);
      return { date, units: item?.units || 0, limit: quota, unit: 'accepted inference operations; targeted analysis counts twice', resetsAt: new Date(Date.parse(date) + 86400000).toISOString() };
    },
    async recover(cursor) {
      const now = Math.floor(clock().getTime() / 1000);
      const response = await db.send(new ScanCommand({ TableName: table, ExclusiveStartKey: cursor, Limit: 100,
        FilterExpression: '(#status = :queued OR #status = :running) AND expiresAt > :now AND updatedAt < :cutoff AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':queued': 'QUEUED', ':running': 'RUNNING', ':now': now, ':cutoff': new Date(clock().getTime() - 15 * 60000).toISOString() } }));
      for (const job of response.Items || []) await store.enqueue(job.tenantId, job.jobId);
      return response.LastEvaluatedKey;
    },
  };
  return store;
}
module.exports = { createStore, final };
