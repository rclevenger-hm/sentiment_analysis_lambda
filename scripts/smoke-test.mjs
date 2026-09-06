const endpoint = process.env.API_ENDPOINT || process.argv[2];

if (!endpoint) {
  console.error('Set API_ENDPOINT or pass the deployed endpoint as the first argument.');
  process.exit(2);
}

const attempts = Number.parseInt(process.env.SMOKE_ATTEMPTS || '6', 10);
const retryDelayMs = Number.parseInt(process.env.SMOKE_RETRY_DELAY_MS || '3000', 10);
const validSentiments = new Set(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED']);
let lastError;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'I am happy this deployment works.' }),
    });

    const body = await response.json();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    }

    if (!validSentiments.has(body.sentiment) || !body.sentimentScore) {
      throw new Error(`Unexpected API response: ${JSON.stringify(body)}`);
    }

    console.log(JSON.stringify({ endpoint, status: response.status, ...body }, null, 2));
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

console.error(`Smoke test failed after ${attempts} attempts: ${lastError?.message}`);
process.exit(1);
