'use strict';

const MAX_REQUEST_BYTES = 16 * 1024;
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

function responseHeaders(requestId) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': process.env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'OPTIONS,POST',
    'access-control-allow-headers': 'Content-Type',
  };

  if (requestId) {
    headers['x-request-id'] = requestId;
  }

  return headers;
}

function jsonResponse(statusCode, body, requestId) {
  return {
    statusCode,
    headers: responseHeaders(requestId),
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

function trustedRequestId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requestIdFrom(event, context = {}) {
  return trustedRequestId(event?.requestContext?.requestId)
    || trustedRequestId(context?.awsRequestId);
}

function createHandler({ client, DetectSentimentCommand }) {
  if (!client || typeof client.send !== 'function') {
    throw new TypeError('A Comprehend client with a send() method is required');
  }

  if (typeof DetectSentimentCommand !== 'function') {
    throw new TypeError('DetectSentimentCommand must be a constructor');
  }

  return async function handler(event = {}, context = {}) {
    const requestId = requestIdFrom(event, context);

    if (
      typeof event?.body === 'string'
      && Buffer.byteLength(event.body, 'utf8') > MAX_REQUEST_BYTES
    ) {
      return jsonResponse(413, {
        error: `Request body must be ${MAX_REQUEST_BYTES} UTF-8 bytes or fewer`,
      }, requestId);
    }

    let payload;
    try {
      payload = parsePayload(event);
    } catch (_error) {
      return jsonResponse(400, { error: 'Request body must contain valid JSON' }, requestId);
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const languageCode = payload.languageCode || 'en';

    if (!text) {
      return jsonResponse(400, { error: 'text must be a non-empty string' }, requestId);
    }

    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      return jsonResponse(413, {
        error: `text must be ${MAX_TEXT_BYTES} UTF-8 bytes or fewer`,
      }, requestId);
    }

    if (!SUPPORTED_LANGUAGE_CODES.has(languageCode)) {
      return jsonResponse(400, { error: 'Unsupported languageCode' }, requestId);
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
      }, requestId);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'sentiment_service_error',
        requestId,
        errorName: error?.name || 'Error',
        message: error?.message || 'Unknown service error',
      }));
      return jsonResponse(502, { error: 'Sentiment service unavailable' }, requestId);
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

async function analyzeSentiment(event, context) {
  return getDefaultHandler()(event, context);
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_TEXT_BYTES,
  analyzeSentiment,
  createHandler,
};
