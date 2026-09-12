'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_REQUEST_BYTES,
  MAX_TEXT_BYTES,
  createHandler,
} = require('../lambda_function/handler');

class DetectSentimentCommand {
  constructor(input) {
    this.input = input;
  }
}

function createTestHandler({ result, error } = {}) {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command.input);
      if (error) {
        throw error;
      }
      return result || {
        Sentiment: 'POSITIVE',
        SentimentScore: {
          Positive: 0.99,
          Negative: 0.001,
          Neutral: 0.009,
          Mixed: 0,
        },
      };
    },
  };

  return {
    calls,
    handler: createHandler({ client, DetectSentimentCommand }),
  };
}

test('returns sentiment, score, and bounded response headers for a valid request', async () => {
  const { calls, handler } = createTestHandler();
  const response = await handler({
    requestContext: { requestId: 'req-123' },
    body: JSON.stringify({ text: 'I love this product!' }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['access-control-allow-methods'], 'OPTIONS,POST');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-request-id'], 'req-123');
  assert.deepEqual(JSON.parse(response.body), {
    sentiment: 'POSITIVE',
    sentimentScore: {
      Positive: 0.99,
      Negative: 0.001,
      Neutral: 0.009,
      Mixed: 0,
    },
  });
  assert.deepEqual(calls, [
    {
      LanguageCode: 'en',
      Text: 'I love this product!',
    },
  ]);
});

test('does not reflect an untrusted request id when API Gateway did not provide one', async () => {
  const { handler } = createTestHandler();
  const response = await handler({
    headers: { 'x-request-id': 'caller-controlled' },
    body: JSON.stringify({ text: 'hello' }),
  });

  assert.equal(response.headers['x-request-id'], undefined);
});

test('uses the configured CORS origin', async () => {
  const originalOrigin = process.env.ALLOWED_ORIGIN;
  process.env.ALLOWED_ORIGIN = 'https://example.com';

  try {
    const { handler } = createTestHandler();
    const response = await handler({
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(
      response.headers['access-control-allow-origin'],
      'https://example.com',
    );
  } finally {
    if (originalOrigin === undefined) {
      delete process.env.ALLOWED_ORIGIN;
    } else {
      process.env.ALLOWED_ORIGIN = originalOrigin;
    }
  }
});

test('accepts a supported languageCode', async () => {
  const { calls, handler } = createTestHandler();
  const response = await handler({
    body: JSON.stringify({ text: 'Me gusta este producto', languageCode: 'es' }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].LanguageCode, 'es');
});

test('rejects malformed JSON', async () => {
  const { handler } = createTestHandler();
  const response = await handler({ body: '{not-json' });

  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /valid JSON/);
});

test('rejects oversized request bodies before JSON parsing or service calls', async () => {
  const { calls, handler } = createTestHandler();
  const response = await handler({
    requestContext: { requestId: 'req-large' },
    body: 'x'.repeat(MAX_REQUEST_BYTES + 1),
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.headers['x-request-id'], 'req-large');
  assert.match(JSON.parse(response.body).error, /Request body/);
  assert.equal(calls.length, 0);
});

test('rejects an empty text field', async () => {
  const { handler } = createTestHandler();
  const response = await handler({ body: JSON.stringify({ text: '   ' }) });

  assert.equal(response.statusCode, 400);
});

test('rejects text larger than the Comprehend request limit', async () => {
  const { handler } = createTestHandler();
  const response = await handler({
    body: JSON.stringify({ text: 'a'.repeat(MAX_TEXT_BYTES + 1) }),
  });

  assert.equal(response.statusCode, 413);
});

test('rejects unsupported language codes', async () => {
  const { handler } = createTestHandler();
  const response = await handler({
    body: JSON.stringify({ text: 'hello', languageCode: 'xx' }),
  });

  assert.equal(response.statusCode, 400);
});

test('returns 502 and structured correlation data when Comprehend fails', async () => {
  const originalConsoleError = console.error;
  const logLines = [];
  console.error = (line) => logLines.push(line);

  try {
    const { handler } = createTestHandler({ error: new Error('AWS unavailable') });
    const response = await handler({
      requestContext: { requestId: 'req-failure' },
      body: JSON.stringify({ text: 'hello' }),
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.headers['x-request-id'], 'req-failure');
    assert.deepEqual(JSON.parse(response.body), {
      error: 'Sentiment service unavailable',
    });
    assert.deepEqual(JSON.parse(logLines[0]), {
      event: 'sentiment_service_error',
      requestId: 'req-failure',
      errorName: 'Error',
      message: 'AWS unavailable',
    });
  } finally {
    console.error = originalConsoleError;
  }
});
