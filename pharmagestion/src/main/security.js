'use strict';
/**
 * Security helpers kept in a pure module so they can be unit-tested without
 * Electron (see tests/security.test.js).
 */

const { AppError } = require('./utils/common');

/** Lowercase namespace, colon, camelCase action: `backup:restore`. */
const METHOD_PATTERN = /^[a-z][a-z0-9]*:[a-zA-Z0-9]+$/;

/** Max accepted payload serialised size (a form is a few kilobytes). */
const MAX_PAYLOAD_JSON = 200 * 1024;

/**
 * Only pages loaded from the local package may use the IPC bridge.
 * `file://` is what `loadFile()` produces; anything else (http, data:, about:)
 * is refused.
 */
function isTrustedFrameUrl(url) {
  return typeof url === 'string' && url.startsWith('file://');
}

function isValidMethodName(name) {
  return typeof name === 'string' && name.length <= 64 && METHOD_PATTERN.test(name);
}

/**
 * @param {Set<string>} allowed
 * @param {string} method
 * @throws {AppError} UNKNOWN_METHOD / INVALID_METHOD
 */
function assertAllowedMethod(allowed, method) {
  if (!isValidMethodName(method)) {
    throw new AppError('UNKNOWN_METHOD', `Invalid method name: ${String(method).slice(0, 60)}`);
  }
  if (!(allowed instanceof Set) || !allowed.has(method)) {
    throw new AppError('UNKNOWN_METHOD', `Unknown method: ${method}`);
  }
  return method;
}

/** Refuse absurdly large payloads before doing any work with them. */
function assertPayloadSize(payload) {
  let size = 0;
  try {
    size = JSON.stringify(payload ?? {}).length;
  } catch (error) {
    throw new AppError('INVALID_PAYLOAD', 'Payload cannot be serialised');
  }
  if (size > MAX_PAYLOAD_JSON) {
    throw new AppError('INVALID_PAYLOAD', 'Payload is too large');
  }
  return payload;
}

/**
 * Build the object handed back to the preload. Known AppErrors keep their
 * code; unexpected errors are logged by the caller and genericised here so a
 * stack trace or SQL text never reaches the window.
 */
function toErrorPayload(error, isAppError) {
  if (isAppError(error)) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal error, see pharmagestion.log' };
}

module.exports = {
  METHOD_PATTERN,
  MAX_PAYLOAD_JSON,
  isTrustedFrameUrl,
  isValidMethodName,
  assertAllowedMethod,
  assertPayloadSize,
  toErrorPayload,
};
