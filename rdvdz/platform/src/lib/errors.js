/**
 * Erreurs applicatives normalisées.
 *
 * Un `code` stable est le contrat entre l'API et les interfaces (traduction
 * AR/FR côté client) : il ne doit jamais changer sans version d'API.
 */

export class AppError extends Error {
  /**
   * @param {string} code code stable (ex. SLOT_TAKEN)
   * @param {string} [message] message technique (jamais montré tel quel à l'utilisateur final)
   * @param {number} [status] code HTTP
   * @param {Record<string, unknown>} [details] informations structurées
   */
  constructor(code, message = code, status = 400, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const Errors = {
  authRequired: () => new AppError('AUTH_REQUIRED', 'Authentication required', 401),
  csrf: () => new AppError('CSRF_INVALID', 'CSRF token missing or invalid', 403),
  forbidden: (message = 'Forbidden') => new AppError('FORBIDDEN', message, 403),
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404),
  validation: (fields) => new AppError('VALIDATION', 'Invalid input', 422, { fields }),
  conflict: (code = 'CONFLICT', message = 'Conflict', details = {}) => new AppError(code, message, 409, details),
  rateLimited: (retryAfter = 60) => new AppError('RATE_LIMITED', 'Too many requests', 429, { retry_after: retryAfter }),
  /**
   * Refus pour motif légal/configuration. 403 : l'action est interdite, pas
   * simplement en conflit d'état — le client doit afficher un message de blocage.
   */
  legalBlocked: (message, details = {}) => new AppError('LEGAL_BLOCKED', message, 403, details),
  paymentUnverified: (message = 'Payment not verified by provider') =>
    new AppError('PAYMENT_UNVERIFIED', message, 409),
  deviceUnauthorized: (message = 'Device not authorized') =>
    new AppError('DEVICE_UNAUTHORIZED', message, 401),
  internal: (message = 'Internal error') => new AppError('INTERNAL_ERROR', message, 500),
};
