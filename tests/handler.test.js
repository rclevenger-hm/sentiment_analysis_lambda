'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
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

test('returns sentiment and score for a valid request', async () => {
  const { calls, handler } = createTestHandler();
  const response = await handler({
    body: JSON.stringify({ text: 'I love this product!' }),
  });

  assert.equal(response.statusCode, 200);
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

test('returns 502 when Comprehend fails', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const { handler } = createTestHandler({ error: new Error('AWS unavailable') });
    const response = await handler({ body: JSON.stringify({ text: 'hello' }) });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(JSON.parse(response.body), {
      error: 'Sentiment service unavailable',
    });
  } finally {
    console.error = originalConsoleError;
  }
});
