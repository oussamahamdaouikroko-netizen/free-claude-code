'use strict';
/**
 * Browser preview / development server.
 *
 * It serves the exact same renderer as Electron and exposes /api/invoke on top
 * of the exact same handlers + services. Use it to click through the UI
 * without building the Windows installer:
 *
 *   npm run demo   →   http://localhost:4173
 *
 * The demo database lives in demo/demo.sqlite and is seeded with sample data.
 * The demo password is 1234 (only for this local preview).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/main/db');
const auth = require('../src/main/services/auth');
const backup = require('../src/main/services/backup');
const appointments = require('../src/main/services/appointments');
const settings = require('../src/main/services/settings');
const { createHandlers, PUBLIC } = require('../src/main/handlers');
const { AppError } = require('../src/main/utils/common');
const { seedDemoData } = require('../src/main/db/demo-seed');

const DEFAULT_PORT = Number(process.env.PORT || 4173);
const DEFAULT_HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const DEFAULT_DATA_DIR = process.env.DENTARDV_DEMO_DATA || path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------- demo data -------------------------------- */

/* --------------------------------- server --------------------------------- */

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'POST' && url.pathname === '/api/invoke') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (error) {
          return send(res, 400, JSON.stringify({ ok: false, error: { code: 'BAD_JSON' } }));
        }
        const { method, payload } = body;
        try {
          const handler = handlers[method];
          if (!handler) throw new AppError('UNKNOWN_METHOD', method);
          if (!PUBLIC.has(method)) auth.requireUnlocked();
          const data = await handler(payload || {});
          return send(res, 200, JSON.stringify({ ok: true, data }));
        } catch (error) {
          if (error instanceof AppError) {
            return send(res, 200, JSON.stringify({
              ok: false,
              error: { code: error.code, message: error.message, details: error.details },
            }));
          }
          console.error('[demo]', method, error);
          return send(res, 200, JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } }));
        }
      }

      if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true }));

      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const file = path.resolve(ROOT, relative);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      }
      const ext = path.extname(file).toLowerCase();
      return send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
    } catch (error) {
      console.error('[demo] request failed', error);
      return send(res, 500, 'Internal error', 'text/plain; charset=utf-8');
    }
  });
}

let handlers = {};

/**
 * Prepare the demo database + handlers and bind the HTTP server.
 * Exported so the renderer smoke test can spin up an isolated instance.
 */
async function startDemo(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const dbFile = path.join(dataDir, 'demo.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });

  db.open(dbFile);
  backup.init(dataDir);
  seedDemoData();

  handlers = createHandlers({
    version: '1.0.0-demo',
    dataDir,
    demo: true,
    // No Baileys in the browser preview, and printing needs Electron.
    wa: null,
    printReceipt: null,
    dialogs: {
      openPath: () => {},
      chooseBackup: async () => ({ canceled: true }),
      saveBackup: async () => ({ canceled: true }),
    },
  });

  if (!auth.hasPassword()) auth.setup({ password: '1234', confirm: '1234' });
  auth.login('1234');

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  // Use the bound address, not "localhost": on Windows localhost resolves to
  // IPv6 first while the server may only listen on IPv4.
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return {
    server,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    dataDir,
    dbFile,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

if (require.main === module) {
  startDemo().then((demo) => {
    console.log(`\nDentaRDV demo → ${demo.url}\n(data: ${demo.dbFile})\n`);
  }).catch((error) => {
    console.error('[demo] failed to start', error);
    process.exit(1);
  });
}

module.exports = { startDemo, createServer, seedDemoData };
