/**
 * Pont léger vers les helpers d'identité du module auth.
 *
 * Évite un import circulaire entre les routes et le module d'authentification,
 * tout en gardant une seule implémentation de la résolution d'identité.
 */

import * as authService from '../modules/auth/service.js';

export const auth = {
  identityFor: authService.identityFor,
  sanitizeUser: authService.sanitizeUser,
};
