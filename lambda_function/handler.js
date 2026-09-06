'use strict';

const MAX_TEXT_BYTES = 5000;
const SUPPORTED_LANGUAGE_CODES = new Set([
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'it',
  'ja',
  'ko',
  'pt',
  'zh',
  'zh-TW',
]);

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function parsePayload(event) {
  if (typeof event?.body === 'string') {
    return JSON.parse(event.body);
  }

  if (event?.body && typeof event.body === 'object') {
    return event.body;
  }

  if (event && typeof event === 'object' && 'text' in event) {
    return event;
  }

  return {};
}

function createHandler({ client, DetectSentimentCommand }) {
  if (!client || typeof client.send !== 'function') {
    throw new TypeError('A Comprehend client with a send() method is required');
  }

  if (typeof DetectSentimentCommand !== 'function') {
    throw new TypeError('DetectSentimentCommand must be a constructor');
  }

  return async function handler(event = {}) {
    let payload;

    try {
      payload = parsePayload(event);
    } catch (_error) {
      return jsonResponse(400, { error: 'Request body must contain valid JSON' });
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const languageCode = payload.languageCode || 'en';

    if (!text) {
      return jsonResponse(400, { error: 'text must be a non-empty string' });
    }

    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      return jsonResponse(413, {
        error: `text must be ${MAX_TEXT_BYTES} UTF-8 bytes or fewer`,
      });
    }

    if (!SUPPORTED_LANGUAGE_CODES.has(languageCode)) {
      return jsonResponse(400, { error: 'Unsupported languageCode' });
    }

    try {
      const result = await client.send(
        new DetectSentimentCommand({
          LanguageCode: languageCode,
          Text: text,
        }),
      );

      return jsonResponse(200, {
        sentiment: result.Sentiment,
        sentimentScore: result.SentimentScore || null,
      });
    } catch (error) {
      console.error('Error analyzing sentiment:', error);
      return jsonResponse(502, { error: 'Sentiment service unavailable' });
    }
  };
}

let defaultHandler;

function getDefaultHandler() {
  if (!defaultHandler) {
    const {
      ComprehendClient,
      DetectSentimentCommand,
    } = require('@aws-sdk/client-comprehend');

    defaultHandler = createHandler({
      client: new ComprehendClient({}),
      DetectSentimentCommand,
    });
  }

  return defaultHandler;
}

async function analyzeSentiment(event) {
  return getDefaultHandler()(event);
}

module.exports = {
  MAX_TEXT_BYTES,
  analyzeSentiment,
  createHandler,
};
