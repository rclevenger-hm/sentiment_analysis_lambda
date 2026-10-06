'use strict';

const { invalid, dateOnly, object } = require('./input');
const SENTIMENTS = new Set(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED']);

function targetedEntities(entities, text) {
  const chars = Array.from(text);
  return (entities || []).slice(0, 10).map((entity) => ({
    mentions: (entity.Mentions || []).slice(0, 3).map((mention) => ({
      text: String(mention.Text || '').slice(0, 160),
      type: mention.Type,
      sentiment: mention.MentionSentiment?.Sentiment,
      sentimentScore: mention.MentionSentiment?.SentimentScore,
      beginOffset: mention.BeginOffset,
      endOffset: mention.EndOffset,
      excerpt: chars.slice(Math.max(0, mention.BeginOffset - 40), Math.min(chars.length, mention.EndOffset + 40)).join('').slice(0, 240),
    })),
    truncated: (entity.Mentions || []).length > 3,
  }));
}

function filtersFrom(query = {}) {
  const filters = {};
  if (query.sentiment !== undefined) {
    if (!SENTIMENTS.has(query.sentiment)) throw invalid('Invalid sentiment filter');
    filters.sentiment = query.sentiment;
  }
  for (const key of ['product', 'source', 'languageCode']) if (query[key] !== undefined) {
    if (typeof query[key] !== 'string' || query[key].length > 120) throw invalid(`Invalid ${key} filter`);
    filters[key] = query[key];
  }
  for (const key of ['from', 'to']) if (query[key] !== undefined) filters[key] = dateOnly(query[key]);
  if (filters.from && filters.to && filters.from > filters.to) throw invalid('from must be before to');
  if (query.minConfidence !== undefined) {
    const value = Number(query.minConfidence);
    if (query.minConfidence === '' || !Number.isFinite(value) || value < 0 || value > 1) throw invalid('minConfidence must be between 0 and 1');
    filters.minConfidence = value;
  }
  return filters;
}

function confidence(record) { return record.sentimentScore?.[record.sentiment?.[0] + record.sentiment?.slice(1).toLowerCase()] ?? 0; }
function filterResults(records, filters = {}, fallbackDate) {
  return records.filter((record) => {
    for (const key of ['product', 'source', 'languageCode', 'sentiment']) if (filters[key] !== undefined && record[key] !== filters[key]) return false;
    const date = record.date || fallbackDate;
    if (filters.from && (!date || date < filters.from)) return false;
    if (filters.to && (!date || date > filters.to)) return false;
    if (filters.minConfidence !== undefined && confidence(record) < filters.minConfidence) return false;
    return true;
  });
}

function summarize(records, fallbackDate) {
  const counts = { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0, MIXED: 0 };
  const days = new Map(); const concerns = new Map();
  let failed = 0; let insightFailures = 0;
  for (const record of records) {
    if (!SENTIMENTS.has(record.sentiment)) { failed++; continue; }
    counts[record.sentiment]++;
    if (record.insightsError) insightFailures++;
    const day = record.date || fallbackDate;
    const trend = days.get(day) || { date: day, total: 0, negative: 0 };
    trend.total++; trend.negative += Number(record.sentiment === 'NEGATIVE'); days.set(day, trend);
    const seen = new Set();
    for (const entity of record.entities || []) for (const mention of entity.mentions) {
      const key = mention.text.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const concern = concerns.get(key) || { text: mention.text, records: 0, negative: 0, evidence: [] };
      concern.records++; concern.negative += Number(mention.sentiment === 'NEGATIVE');
      if (concern.evidence.length < 3) concern.evidence.push({ recordId: record.id, sentiment: mention.sentiment, excerpt: mention.excerpt });
      concerns.set(key, concern);
    }
  }
  const analyzed = records.length - failed;
  return {
    total: records.length, analyzed, failed, insightFailures, counts,
    negativeRate: analyzed ? counts.NEGATIVE / analyzed : null,
    trends: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({ ...day, negativeRate: day.negative / day.total })),
    concerns: [...concerns.values()].sort((a, b) => b.negative - a.negative || b.records - a.records).slice(0, 30),
  };
}

function compare(current, baseline) {
  return { current, baseline, analyzedChange: current.analyzed - baseline.analyzed,
    negativeRateChange: current.negativeRate === null || baseline.negativeRate === null ? null : current.negativeRate - baseline.negativeRate,
    note: 'Rates use successfully analyzed records. Differences describe these samples; they do not establish statistical significance.' };
}

function csvExport(records) {
  // Prefix spreadsheet formulas, including leading whitespace/control characters.
  const cell = (value) => {
    let text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const columns = ['id', 'text', 'date', 'product', 'source', 'languageCode', 'sentiment', 'sentimentScore', 'entities', 'error', 'insightsError'];
  return [columns.join(','), ...records.map((record) => columns.map((key) => cell(record[key])).join(','))].join('\r\n');
}

function validateRule(value) {
  if (value.filters !== undefined && !object(value.filters)) throw invalid('filters must be an object');
  if (typeof value.enabled !== 'boolean') throw invalid('enabled must be boolean');
  if (!Number.isInteger(value.minRecords) || value.minRecords < 1 || value.minRecords > 200) throw invalid('minRecords must be between 1 and 200');
  if (typeof value.negativeRate !== 'number' || !Number.isFinite(value.negativeRate) || value.negativeRate < 0 || value.negativeRate > 1) throw invalid('negativeRate must be between 0 and 1');
  return { enabled: value.enabled, minRecords: value.minRecords, negativeRate: value.negativeRate,
    filters: filtersFrom(value.filters || {}) };
}

function evaluateRule(rule, records, fallbackDate) {
  if (!rule?.enabled) return null;
  const summary = summarize(filterResults(records, rule.filters, fallbackDate), fallbackDate);
  if (summary.analyzed < rule.minRecords || summary.negativeRate < rule.negativeRate) return null;
  return { type: 'NEGATIVE_SENTIMENT_THRESHOLD', analyzed: summary.analyzed, negativeRate: summary.negativeRate,
    threshold: rule.negativeRate, message: `${summary.counts.NEGATIVE} of ${summary.analyzed} analyzed records were negative`,
    evidenceRecordIds: filterResults(records, { ...rule.filters, sentiment: 'NEGATIVE' }, fallbackDate).slice(0, 10).map((record) => record.id) };
}

module.exports = { SENTIMENTS, targetedEntities, filtersFrom, filterResults, summarize, compare, csvExport, validateRule, evaluateRule };
