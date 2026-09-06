const endpoint = process.env.API_ENDPOINT;

if (!endpoint) {
  throw new Error('Set API_ENDPOINT to the Terraform api_endpoint_url output.');
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: process.argv.slice(2).join(' ') || 'This integration works well.',
    languageCode: 'en',
  }),
});

const body = await response.json();

if (!response.ok) {
  throw new Error(`Sentiment API returned ${response.status}: ${JSON.stringify(body)}`);
}

console.log(body);
