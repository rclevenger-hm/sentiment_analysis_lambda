import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request } from './client.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const name = args[i].slice(2);
    if (name === 'targeted') options[name] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${name}`); options[name] = args[++i]; }
  } else positional.push(args[i]);
}
function query(extra = {}) {
  const values = { ...options, ...extra }; delete values.out; delete values.key; delete values.targeted;
  const encoded = new URLSearchParams(values).toString(); return encoded ? `?${encoded}` : '';
}
try {
  let response;
  if (command === 'analyze') response = await request('/analyze-sentiment', { method: 'POST', body: JSON.stringify({ text: positional.join(' '), languageCode: options.languageCode || 'en', targeted: Boolean(options.targeted) }) });
  else if (command === 'submit') {
    const file = positional[0]; if (!file) throw new Error('submit requires a .json or .csv file');
    const key = options.key || randomUUID();
    console.error(`Idempotency-Key: ${key} (reuse this key to retry the same submission)`);
    let body = await readFile(file, 'utf8');
    if (!file.endsWith('.csv') && options.targeted) body = JSON.stringify({ ...JSON.parse(body), targeted: true });
    response = await request(`/jobs${options.targeted ? '?targeted=true' : ''}`, { method: 'POST', body, contentType: file.endsWith('.csv') ? 'text/csv' : 'application/json', idempotencyKey: key });
  } else if (['status', 'results', 'report', 'export'].includes(command)) {
    if (!positional[0]) throw new Error(`${command} requires a job id`);
    response = await request(`/jobs/${encodeURIComponent(positional[0])}${command === 'status' ? '' : `/${command}`}${query()}`);
  } else if (['history', 'usage', 'alerts'].includes(command)) response = await request(`/${command}${query()}`);
  else if (command === 'compare') {
    if (positional.length !== 2) throw new Error('compare requires current and baseline job ids');
    response = await request(`/compare${query({ current: positional[0], baseline: positional[1] })}`);
  } else if (command === 'rule') response = await request('/alert-rule', positional[0] ? { method: 'PUT', body: await readFile(positional[0], 'utf8') } : {});
  else if (command === 'acknowledge') {
    if (!positional[0]) throw new Error('acknowledge requires a job id');
    response = await request(`/alerts/${encodeURIComponent(positional[0])}/acknowledge`, { method: 'PUT' });
  } else throw new Error('Commands: analyze TEXT | submit FILE [--key KEY] | status/results/report/export JOB | history | compare CURRENT BASELINE | usage | alerts | rule [FILE] | acknowledge JOB. Filters: --sentiment NEGATIVE --source SOURCE --product PRODUCT --from YYYY-MM-DD --to YYYY-MM-DD. Export: --format csv --out results.csv');
  if (command === 'export') {
    const exported = JSON.parse(response.text);
    const url = new URL(exported.downloadUrl);
    if (url.protocol !== 'https:') throw new Error('Export URL must use HTTPS');
    const downloaded = await fetch(url, { signal: AbortSignal.timeout(35000) });
    if (!downloaded.ok) throw new Error(`Export download failed: ${downloaded.status}`);
    response = { text: await downloaded.text(), contentType: downloaded.headers.get('content-type') };
  }
  if (options.out) { await writeFile(options.out, response.text); console.error(`Saved ${options.out}`); }
  else console.log(response.contentType?.includes('json') ? JSON.stringify(JSON.parse(response.text), null, 2) : response.text);
} catch (error) { console.error(error.message); process.exitCode = 1; }
