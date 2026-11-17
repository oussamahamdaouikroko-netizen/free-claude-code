'use strict';
/**
 * Typed application errors. Every error carries a machine-readable `code`
 * so the API returns a stable shape: { error: { code, message, details } }.
 * Unexpected errors are never leaked to clients (see server.js).
 */
class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

const STATUS_BY_CODE = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  GONE: 410,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SLOT_TAKEN: 409,
  DUPLICATE_PAYMENT: 409,
  INVALID_STATE: 409,
  WHATSAPP_DISABLED: 503,
  WHATSAPP_NOT_CONNECTED: 409,
  PAYMENT_REQUIRED: 402,
};

function statusFor(code) {
  return STATUS_BY_CODE[code] || 500;
}

function validation(message, details) {
  return new AppError('VALIDATION', message, details);
}
function notFound(what = 'Resource') {
  return new AppError('NOT_FOUND', `${what} not found`);
}
function forbidden(message = 'Forbidden') {
  return new AppError('FORBIDDEN', message);
}
function unauthorized(message = 'Authentication required') {
  return new AppError('UNAUTHORIZED', message);
}
function conflict(code, message, details) {
  return new AppError(code, message, details);
}

module.exports = { AppError, statusFor, validation, notFound, forbidden, unauthorized, conflict };
