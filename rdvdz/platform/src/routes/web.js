/**
 * Service des fichiers statiques de l'application web (PWA patient +
 * console opérateur + administration).
 *
 * Pourquoi pas `@fastify/static` : le front est volontairement sans étape de
 * build (aucun bundler, aucune dépendance npm côté navigateur). Servir un
 * dossier de fichiers est trivial, et le faire ici permet de contrôler
 * exactement les en-têtes de sécurité envoyés au navigateur.
 *
 * Règles appliquées :
 *  - aucun `..` ne peut sortir du dossier `web/` (normalisation + vérification) ;
 *  - `index.html` est servi pour toute route inconnue qui n'est pas une API
 *    (navigation côté client), JAMAIS de HTML sur un chemin `/api/` ;
 *  - les assets ont une politique de cache longue, l'HTML aucune ;
 *  - la CSP du front autorise uniquement `'self'` (+ styles inline, nécessaires
 *    aux valeurs de thème calculées).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(__dirname, '..', 'web');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/** En-têtes de sécurité propres au front (l'API garde les siens). */
function staticHeaders(reply, ext, isHtml) {
  reply.header('x-rdvdz-static', '1');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  );
  // Les fichiers sans empreinte dans le nom ne doivent jamais être figés en
  // cache : un correctif de sécurité front doit atteindre les navigateurs.
  const noStore = isHtml || ext === '.webmanifest' || ext === '.js';
  reply.header(
    'Cache-Control',
    noStore ? 'no-cache, must-revalidate' : ext === '.svg' ? 'public, max-age=86400' : 'public, max-age=3600',
  );
}

/** Résout un chemin demandé en fichier réel DANS le dossier web. */
async function resolveAsset(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // pourcentage mal encodé
  }
  if (decoded.includes('\0') || decoded.includes('..')) return null;

  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const candidate = path.resolve(WEB_ROOT, relative);
  // Double vérification : la normalisation ne suffit pas seule.
  if (candidate !== WEB_ROOT && !candidate.startsWith(`${WEB_ROOT}${path.sep}`)) return null;

  try {
    const info = await stat(candidate);
    if (!info.isFile()) return null;
    return { file: candidate, size: info.size };
  } catch {
    return null;
  }
}

/**
 * Déclare les routes du front.
 * @param {import('fastify').FastifyInstance} app
 */
export default async function webRoutes(app) {
  const serveFile = async (request, reply, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    staticHeaders(reply, ext, isHtml);
    reply.header('Content-Type', MIME.get(ext) ?? 'application/octet-stream');
    if (!isHtml) reply.header('Content-Length', String((await stat(filePath)).size));
    return reply.send(createReadStream(filePath));
  };

  /** Fichiers réels (JS, CSS, manifeste, icônes…). */
  app.get('/*', async (request, reply) => {
    const urlPath = request.url.split('?')[0];
    if (urlPath.startsWith('/api/')) return reply.callNotFound();

    const asset = await resolveAsset(urlPath);
    if (asset) return serveFile(request, reply, asset.file);

    // Un asset manquant (extension connue) est une vraie 404, pas l'index.
    const ext = path.extname(urlPath).toLowerCase();
    if (ext && ext !== '.html') {
      return reply.code(404).type('application/json; charset=utf-8').send({
        error: { code: 'NOT_FOUND', message: 'Ressource introuvable', details: {} },
      });
    }

    // Navigation côté client : on renvoie la coquille de l'application.
    const index = path.join(WEB_ROOT, 'index.html');
    return serveFile(request, reply, index);
  });
}

export { resolveAsset };
