import { request } from './client.mjs';
const response = JSON.parse((await request('/analyze-sentiment', { method: 'POST', body: JSON.stringify({ text: 'This service works well.' }) })).text);
if (!['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED'].includes(response.sentiment) || !response.sentimentScore) throw new Error('Unexpected analysis response');
console.log('Authenticated API Gateway → Lambda → Comprehend smoke test passed.');
