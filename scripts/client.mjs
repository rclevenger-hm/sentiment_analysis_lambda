import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

export async function request(path, { method = 'GET', body, contentType = 'application/json', idempotencyKey, endpoint = process.env.API_ENDPOINT, region = process.env.AWS_REGION || 'us-east-1', credentials = defaultProvider() } = {}) {
  if (!endpoint) throw new Error('Set API_ENDPOINT to the stage base URL');
  const base = endpoint.replace(/\/analyze-sentiment\/?$/, '').replace(/\/$/, '');
  const url = new URL(`${base}${path}`);
  if (url.protocol !== 'https:') throw new Error('API_ENDPOINT must use HTTPS');
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const headers = { host: url.host, 'content-type': contentType };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const signer = new SignatureV4({ service: 'execute-api', region, credentials, sha256: Sha256 });
  const signed = await signer.sign(new HttpRequest({ protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined, path: url.pathname, query, method, headers, body }));
  const response = await fetch(url, { method, headers: signed.headers, body, signal: AbortSignal.timeout(35000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} (${response.headers.get('x-request-id') || 'no request id'}): ${text}`);
  return { text, contentType: response.headers.get('content-type'), status: response.status };
}
