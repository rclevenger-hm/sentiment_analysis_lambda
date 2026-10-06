'use strict';

const { ComprehendClient, DetectSentimentCommand, DetectTargetedSentimentCommand, BatchDetectSentimentCommand, BatchDetectTargetedSentimentCommand } = require('@aws-sdk/client-comprehend');
const { SENTIMENTS, targetedEntities } = require('./insights');
const transient = (error) => /Throttl|TooManyRequests|Internal|Unavailable|Timeout|Abort|Networking|ECONN|ETIMEDOUT/i.test(error?.name || error?.code || '') || error?.$metadata?.httpStatusCode >= 500;
const safeError = (error) => ({ code: String(error?.name || error?.ErrorCode || 'ANALYSIS_FAILED').slice(0, 80), message: 'Analysis could not be completed for this record' });
function scores(result) {
  if (!SENTIMENTS.has(result?.Sentiment) || !result.SentimentScore) throw Object.assign(new Error('Malformed upstream result'), { name: 'InvalidUpstreamResponse' });
  return { sentiment: result.Sentiment, sentimentScore: result.SentimentScore };
}

function createAnalyzer(client = new ComprehendClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } })) {
  return {
    async single(record, targeted = false) {
      const result = scores(await client.send(new DetectSentimentCommand({ Text: record.text, LanguageCode: record.languageCode })));
      if (targeted) {
        const detail = await client.send(new DetectTargetedSentimentCommand({ Text: record.text, LanguageCode: 'en' }));
        result.entities = targetedEntities(detail.Entities, record.text);
        result.entitiesTruncated = (detail.Entities || []).length > 10;
      }
      return result;
    },
    async batch(records, targeted = false) {
      const results = records.map((record) => ({ ...record }));
      const groups = new Map();
      for (let i = 0; i < records.length; i++) if (!records[i].error) {
        const group = groups.get(records[i].languageCode) || []; group.push(i); groups.set(records[i].languageCode, group);
      }
      for (const [language, indices] of groups) {
        const input = { LanguageCode: language, TextList: indices.map((index) => records[index].text) };
        let response;
        try { response = await client.send(new BatchDetectSentimentCommand(input)); }
        catch (error) {
          if (transient(error)) throw error;
          for (const index of indices) results[index].error = safeError(error);
          continue;
        }
        const byIndex = new Map((response.ResultList || []).map((result) => [result.Index, result]));
        const errors = new Map((response.ErrorList || []).map((error) => [error.Index, error]));
        for (let i = 0; i < indices.length; i++) {
          const error = errors.get(i);
          if (error && transient({ name: error.ErrorCode })) throw Object.assign(new Error('Transient batch item failure'), { name: error.ErrorCode });
          try { if (error) results[indices[i]].error = safeError(error); else Object.assign(results[indices[i]], scores(byIndex.get(i))); }
          catch (err) { results[indices[i]].error = safeError(err); }
        }
        if (targeted) {
          try {
            const detail = await client.send(new BatchDetectTargetedSentimentCommand(input));
            const detailByIndex = new Map((detail.ResultList || []).map((result) => [result.Index, result]));
            const detailErrors = new Map((detail.ErrorList || []).map((error) => [error.Index, error]));
            for (let i = 0; i < indices.length; i++) {
              const item = results[indices[i]]; if (item.error) continue;
              const error = detailErrors.get(i);
              if (error && transient({ name: error.ErrorCode })) throw Object.assign(new Error('Transient insights failure'), { name: error.ErrorCode });
              if (error || !detailByIndex.has(i)) item.insightsError = safeError(error);
              else { const entities = detailByIndex.get(i).Entities || []; item.entities = targetedEntities(entities, item.text); item.entitiesTruncated = entities.length > 10; }
            }
          } catch (error) {
            if (transient(error)) throw error;
            for (const index of indices) if (!results[index].error) results[index].insightsError = safeError(error);
          }
        }
      }
      return results;
    },
  };
}
module.exports = { createAnalyzer, transient };
