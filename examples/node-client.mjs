import { request } from '../scripts/client.mjs';
const result = await request('/analyze-sentiment', { method: 'POST', body: JSON.stringify({ text: process.argv.slice(2).join(' ') || 'This service works well.' }) });
console.log(result.text);
