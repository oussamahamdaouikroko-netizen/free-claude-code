'use strict';
/**
 * Medirdv Central — HTTP server (Node.js built-ins only, zero dependencies).
 *
 * Routes:
 *  - /admin/*        central administration UI (static) + /api/admin/*
 *  - /               patient platform (static) + /api/public/*
 *  - /api/doctor/*   doctor self-service
 *  - /api/connector/* desktop sync API (Bearer API keys)
 *  - /webhooks/whatsapp official Meta webhook (GET verify + POST events)
 *  - /health         liveness + DB check
 *
 * Security: session cookies (httpOnly), per-IP rate limiting on auth +
 * booking endpoints, JSON body caps, receipt upload caps, safe errors.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Load .env BEFORE any module that reads process.env at require-time.
require('./env').loadEnv();

const db = require('./db');
const auth = require('./auth');
const { AppError, statusFor } = require('./errors');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const whatsappRoutes = require('./routes/whatsapp');
const connectorRoutes = require('./routes/connector');
const doctorRoutes = require('./routes/doctor');
const booking = require('./services/booking');
const payments = require('./services/payments');
const whatsapp = require('./services/whatsapp');
const { logAudit } = require('./services/audit');

const JSON_LIMIT = 256 * 1024;
const RECEIPT_LIMIT = 6 * 1024 * 1024;
const STATIC_ROOT = path.join(__dirname, 'static');

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

/* ------------------------------ rate limiting ----------------------------- */
const buckets = new Map();
function rateLimited(ip, key, limit, windowMs) {
  const now = Date.now();
  const bucketKey = `${ip}:${key}`;
  let bucket = buckets.get(bucketKey);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(bucketKey, bucket);
  }
  bucket.count += 1;
  return bucket.count > limit;
}

/* --------------------------------- helpers -------------------------------- */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, error) {
  if (error instanceof AppError) {
    sendJson(res, statusFor(error.code), { error: { code: error.code, message: error.message, details: error.details || null } });
    return;
  }
  // Never leak internals.
  sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Internal server error' } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError('PAYLOAD_TOO_LARGE', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, JSON_LIMIT);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('VALIDATION', 'Request body must be valid JSON');
  }
}

function currentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.getSessionUser(cookies[auth.COOKIE_NAME]);
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new AppError('UNAUTHORIZED', 'Authentication required');
  return user;
}

function serveStatic(res, urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_ROOT, clean);
  if (!filePath.startsWith(STATIC_ROOT)) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // Defence in depth for the inline-free vanilla UI (no inline scripts/styles).
    'Content-Security-Policy': CSP,
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function parseQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return query;
}

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

/**
 * Allowed CORS origins come from MEDIRDV_ALLOWED_ORIGINS (comma separated).
 * Capacitor's native WebView origins are always allowed for the API because
 * the app is a first-party client; the wildcard is never used together with
 * credentials.
 */
const CAPACITOR_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);

function applyCors(req, res, pathname) {
  const origin = req.headers.origin;
  if (!origin || !pathname.startsWith('/api/')) return false;
  const configured = String(process.env.MEDIRDV_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const isAllowed = CAPACITOR_ORIGINS.has(origin) || configured.includes(origin);
  if (!isAllowed) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Transaction-Ref');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/* ---------------------------------- router --------------------------------- */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const query = parseQuery(url);
  const method = req.method;
  const ip = req.socket.remoteAddress || 'unknown';

  // Apply security headers to every response (API and static).
  applySecurityHeaders(res);
  // CORS: the Android app (Capacitor origin) calls this API cross-origin.
  // Only explicitly allowed origins are echoed; credentials ride on cookies
  // for the web UIs, and the native app authenticates via its own session.
  if (applyCors(req, res, pathname)) {
    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  }

  try {
    /* ------------------------------- health ------------------------------- */
    if (pathname === '/health' && method === 'GET') {
      db.getDb().prepare('SELECT 1 AS ok').get();
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    /* --------------------------- WhatsApp webhook -------------------------- */
    if (pathname === '/webhooks/whatsapp' && method === 'GET') {
      const result = whatsappRoutes.verifyWebhook(query);
      res.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(result.body);
    }
    if (pathname === '/webhooks/whatsapp' && method === 'POST') {
      const raw = await readBody(req, JSON_LIMIT);
      const signature = req.headers['x-hub-signature-256'];
      if (!whatsapp.verifyWebhookSignature(raw.toString('utf8'), signature)) {
        return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Invalid webhook signature' } });
      }
      const payload = JSON.parse(raw.toString('utf8'));
      const result = whatsappRoutes.handleWebhook(payload);
      return sendJson(res, 200, { ok: true, ...result });
    }

    /* ------------------------------ auth API ------------------------------- */
    if (pathname === '/api/auth/login' && method === 'POST') {
      if (rateLimited(ip, 'login', 10, 60 * 1000)) throw new AppError('RATE_LIMITED', 'Too many login attempts');
      const body = await readJson(req);
      const user = auth.login(body.email, body.password);
      if (!user) throw new AppError('UNAUTHORIZED', 'Invalid email or password');
      const session = auth.createSession(user.id, { ip, userAgent: req.headers['user-agent'] || '' });
      res.setHeader('Set-Cookie', auth.sessionCookieHeader(session.id, session.expiresAt));
      return sendJson(res, 200, { ok: true, user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name } });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const cookies = auth.parseCookies(req.headers.cookie);
      auth.destroySession(cookies[auth.COOKIE_NAME]);
      res.setHeader('Set-Cookie', auth.clearCookieHeader());
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = currentUser(req);
      if (!user) return sendJson(res, 200, { user: null });
      return sendJson(res, 200, { user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name } });
    }

    /* ----------------------------- public API ------------------------------ */
    if (pathname === '/api/public/specialties' && method === 'GET') {
      return sendJson(res, 200, { specialties: publicRoutes.listSpecialties() });
    }
    if (pathname === '/api/public/wilayas' && method === 'GET') {
      return sendJson(res, 200, { wilayas: publicRoutes.listWilayas() });
    }
    if (pathname === '/api/public/doctors' && method === 'GET') {
      const doctors = publicRoutes.searchDoctors({
        name: query.name, specialtyId: query.specialty_id, wilaya: query.wilaya,
        city: query.city, clinicId: query.clinic_id, availableOn: query.available_on,
      });
      return sendJson(res, 200, { doctors });
    }
    if (pathname.startsWith('/api/public/doctors/') && pathname.endsWith('/slots') && method === 'GET') {
      const parts = pathname.split('/');
      const id = Number(parts[4]);
      const day = query.day;
      if (!day) throw new AppError('VALIDATION', 'day query parameter is required');
      return sendJson(res, 200, { slots: booking.availableSlots(id, day, query.clinic_id ? Number(query.clinic_id) : null) });
    }
    if (pathname.startsWith('/api/public/doctors/') && method === 'GET') {
      const id = Number(pathname.split('/').pop());
      return sendJson(res, 200, { doctor: publicRoutes.getDoctorProfile(id) });
    }
    if (pathname === '/api/public/bookings' && method === 'POST') {
      if (rateLimited(ip, 'booking', 20, 60 * 1000)) throw new AppError('RATE_LIMITED', 'Too many booking attempts');
      const body = await readJson(req);
      const result = publicRoutes.createPublicBooking(body);
      return sendJson(res, 201, result);
    }
    if (pathname === '/api/public/track' && method === 'GET') {
      return sendJson(res, 200, publicRoutes.trackBooking(query.ref, query.phone));
    }
    if (pathname === '/api/public/cancel' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, { appointment: publicRoutes.cancelPublicBooking(body.ref, body.phone) });
    }
    if (pathname.startsWith('/api/public/payments/') && pathname.endsWith('/submit') && method === 'POST') {
      const parts = pathname.split('/');
      const paymentId = Number(parts[4]);
      // Receipt upload: raw body + filename header (keeps server dependency-free).
      const filename = req.headers['x-filename'] || 'receipt';
      const buffer = await readBody(req, RECEIPT_LIMIT);
      const transactionRef = req.headers['x-transaction-ref'] || query.transaction_ref || '';
      const payment = payments.submitPayment(paymentId, { transactionRef, filename, buffer });
      return sendJson(res, 200, { payment });
    }

    /* ------------------------------ admin API ------------------------------ */
    if (pathname.startsWith('/api/admin/')) {
      const user = requireUser(req);
      const sub = pathname.slice('/api/admin/'.length);

      if (sub === 'dashboard' && method === 'GET') {
        auth.requirePermission(user, 'admin:dashboard');
        return sendJson(res, 200, adminRoutes.dashboardStats());
      }
      if (sub === 'analytics' && method === 'GET') {
        auth.requirePermission(user, 'admin:analytics');
        return sendJson(res, 200, adminRoutes.analytics({ from: query.from, to: query.to }));
      }
      if (sub === 'doctors' && method === 'GET') {
        auth.requirePermission(user, 'admin:doctors');
        return sendJson(res, 200, { doctors: adminRoutes.listDoctors({ status: query.status, specialtyId: query.specialty_id, search: query.search }) });
      }
      if (sub === 'doctors' && method === 'POST') {
        return sendJson(res, 201, { doctor: adminRoutes.createDoctor(user, await readJson(req)) });
      }
      if (sub.startsWith('doctors/') && sub.endsWith('/status') && method === 'POST') {
        const id = Number(sub.split('/')[1]);
        const body = await readJson(req);
        return sendJson(res, 200, { doctor: adminRoutes.setDoctorStatus(user, id, body.status) });
      }
      if (sub === 'clinics' && method === 'GET') {
        auth.requirePermission(user, 'admin:clinics');
        return sendJson(res, 200, { clinics: adminRoutes.listClinics() });
      }
      if (sub === 'clinics' && method === 'POST') {
        return sendJson(res, 201, { clinic: adminRoutes.createClinic(user, await readJson(req)) });
      }
      if (sub === 'doctor-clinics' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, adminRoutes.linkDoctorClinic(user, Number(body.doctor_id), Number(body.clinic_id)));
      }
      if (sub === 'schedules' && method === 'POST') {
        return sendJson(res, 201, adminRoutes.setSchedule(user, await readJson(req)));
      }
      if (sub === 'blocked-dates' && method === 'POST') {
        return sendJson(res, 201, adminRoutes.blockDate(user, await readJson(req)));
      }
      if (sub === 'specialties' && method === 'GET') {
        return sendJson(res, 200, { specialties: adminRoutes.listSpecialties() });
      }
      if (sub === 'specialties' && method === 'POST') {
        return sendJson(res, 201, { specialty: adminRoutes.createSpecialty(user, await readJson(req)) });
      }
      if (sub === 'patients' && method === 'GET') {
        auth.requirePermission(user, 'patients:lookup');
        return sendJson(res, 200, { patients: adminRoutes.listPatients({ search: query.search }) });
      }
      if (sub === 'appointments' && method === 'GET') {
        auth.requirePermission(user, 'admin:appointments');
        return sendJson(res, 200, { appointments: booking.listAppointments({ doctorId: query.doctor_id, status: query.status, day: query.day }) });
      }
      if (sub.startsWith('appointments/') && sub.endsWith('/notify-doctor') && method === 'POST') {
        auth.requirePermission(user, 'admin:appointments');
        const id = Number(sub.split('/')[1]);
        const result = await whatsappRoutes.notifyDoctorOfBooking(id);
        return sendJson(res, 200, { ok: true, wa_message_id: result.waMessageId });
      }
      if (sub.startsWith('appointments/') && sub.endsWith('/cancel') && method === 'POST') {
        auth.requirePermission(user, 'admin:appointments');
        const id = Number(sub.split('/')[1]);
        return sendJson(res, 200, { appointment: booking.cancelBooking(id, { actor: `admin:${user.id}` }) });
      }
      if (sub === 'payments' && method === 'GET') {
        auth.requirePermission(user, 'payments:view');
        return sendJson(res, 200, { payments: payments.listPayments({ status: query.status, doctorId: query.doctor_id }) });
      }
      if (sub.startsWith('payments/') && sub.endsWith('/verify') && method === 'POST') {
        auth.requirePermission(user, 'payments:verify');
        const id = Number(sub.split('/')[1]);
        const body = await readJson(req);
        return sendJson(res, 200, { payment: payments.verifyPayment(id, { decision: body.decision, verifierId: user.id, note: body.note || '' }) });
      }
      if (sub.startsWith('payments/') && sub.endsWith('/refund') && method === 'POST') {
        auth.requirePermission(user, 'payments:verify');
        const id = Number(sub.split('/')[1]);
        const body = await readJson(req);
        return sendJson(res, 200, { payment: payments.refundPayment(id, { verifierId: user.id, note: body.note || '' }) });
      }
      if (sub === 'whatsapp/accounts' && method === 'GET') {
        auth.requirePermission(user, 'whatsapp:manage');
        return sendJson(res, 200, { accounts: whatsapp.connectionHealth(), configured: whatsapp.isPlatformConfigured() });
      }
      if (sub.startsWith('whatsapp/doctors/') && sub.endsWith('/connect') && method === 'POST') {
        const id = Number(sub.split('/')[2]);
        return sendJson(res, 200, { account: whatsappRoutes.connectDoctor(user, id, await readJson(req)) });
      }
      if (sub.startsWith('whatsapp/doctors/') && sub.endsWith('/disconnect') && method === 'POST') {
        const id = Number(sub.split('/')[2]);
        return sendJson(res, 200, { account: whatsappRoutes.disconnectDoctor(user, id) });
      }
      if (sub === 'whatsapp/messages' && method === 'GET') {
        auth.requirePermission(user, 'whatsapp:manage');
        return sendJson(res, 200, { messages: whatsapp.listMessages({ doctorId: query.doctor_id }) });
      }
      if (sub === 'whatsapp/retry-failed' && method === 'POST') {
        return sendJson(res, 200, { results: await whatsappRoutes.retryFailedMessages(user) });
      }
      if (sub === 'connector/keys' && method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, connectorRoutes.createDeviceKey(user, Number(body.clinic_id)));
      }
      if (sub.startsWith('connector/keys/') && sub.endsWith('/revoke') && method === 'POST') {
        const id = Number(sub.split('/')[2]);
        return sendJson(res, 200, connectorRoutes.revokeDeviceKey(user, id));
      }
      if (sub === 'audit' && method === 'GET') {
        auth.requirePermission(user, 'admin:dashboard');
        return sendJson(res, 200, { audit: require('./services/audit').listAudit({ limit: query.limit }) });
      }
      if (sub === 'users' && method === 'POST') {
        auth.requirePermission(user, 'admin:settings');
        const body = await readJson(req);
        const created = auth.createUser({ email: body.email, password: body.password, fullName: body.full_name || '', role: body.role });
        logAudit({ userId: user.id, action: 'user.create', entity: 'user', entityId: String(created.id), detail: created.email });
        return sendJson(res, 201, { user: { id: created.id, email: created.email, role: created.role } });
      }
      throw new AppError('NOT_FOUND', 'Admin route not found');
    }

    /* ----------------------------- doctor API ------------------------------ */
    if (pathname.startsWith('/api/doctor/')) {
      const user = requireUser(req);
      const sub = pathname.slice('/api/doctor/'.length);
      if (sub === 'profile' && method === 'GET') return sendJson(res, 200, doctorRoutes.getOwnProfile(user));
      if (sub === 'appointments' && method === 'GET') return sendJson(res, 200, { appointments: doctorRoutes.listOwnAppointments(user, { day: query.day, status: query.status }) });
      if (sub.startsWith('appointments/') && sub.endsWith('/respond') && method === 'POST') {
        const id = Number(sub.split('/')[1]);
        const body = await readJson(req);
        return sendJson(res, 200, { appointment: doctorRoutes.respondToBooking(user, id, body.decision, body) });
      }
      if (sub === 'schedules' && method === 'POST') return sendJson(res, 201, doctorRoutes.updateOwnSchedule(user, await readJson(req)));
      throw new AppError('NOT_FOUND', 'Doctor route not found');
    }

    /* ---------------------------- connector API ---------------------------- */
    if (pathname.startsWith('/api/connector/')) {
      const device = connectorRoutes.authenticateConnector(req.headers.authorization);
      const sub = pathname.slice('/api/connector/'.length);
      if (sub === 'appointments/push-status' && method === 'POST') {
        return sendJson(res, 200, { appointment: connectorRoutes.pushAppointmentStatus(device, await readJson(req)) });
      }
      if (sub === 'availability' && method === 'GET') {
        return sendJson(res, 200, { availability: connectorRoutes.pullAvailability(device, { day: query.day, doctorId: query.doctor_id ? Number(query.doctor_id) : null }) });
      }
      if (sub === 'appointments' && method === 'GET') {
        return sendJson(res, 200, { appointments: connectorRoutes.pullAppointments(device, { day: query.day }) });
      }
      throw new AppError('NOT_FOUND', 'Connector route not found');
    }

    /* ------------------------------ static UI ------------------------------ */
    // /admin and /admin/ → dashboard SPA shell; /admin/app.js etc. → real asset.
    if (pathname === '/admin' || pathname === '/admin/') {
      if (serveStatic(res, 'admin/index.html')) return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      if (serveStatic(res, 'patient/index.html')) return;
    }
    if (serveStatic(res, pathname.slice(1))) return;

    throw new AppError('NOT_FOUND', 'Route not found');
  } catch (error) {
    sendError(res, error);
  }
}

/* ------------------------------- bootstrap --------------------------------- */
function bootstrapAdmin() {
  const email = process.env.MEDIRDV_BOOTSTRAP_ADMIN_EMAIL || '';
  const password = process.env.MEDIRDV_BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!email || !password) return;
  const existing = auth.getUserByEmail(email);
  if (existing) return;
  auth.createUser({ email, password, fullName: 'Super Administrator', role: 'super_admin' });
  console.log(`[medirdv-central] Bootstrap super admin created: ${email}`);
}

function start() {
  db.open();
  bootstrapAdmin();
  // Seed default specialties + payment methods (idempotent).
  const dbConn = db.getDb();
  const specialties = [
    ['general-medicine', 'Médecine Générale', 'طب عام'],
    ['cardiology', 'Cardiologie', 'قلب'],
    ['ophthalmology', 'Ophtalmologie', 'عيون'],
    ['orthopedics', 'Orthopédie', 'عظام'],
    ['pediatrics', 'Pédiatrie', 'أطفال'],
    ['gynecology', 'Gynécologie', 'نساء وتوليد'],
    ['ent', 'ORL', 'أنف وأذن وحنجرة'],
    ['dermatology', 'Dermatologie', 'جلد'],
    ['gastroenterology', 'Gastro-entérologie', 'هضم'],
    ['neurology', 'Neurologie', 'أعصاب'],
    ['urology', 'Urologie', 'مسالك بولية'],
    ['dentistry', 'Dentaire', 'أسنان'],
  ];
  for (const [slug, fr, ar] of specialties) {
    dbConn.prepare('INSERT OR IGNORE INTO specialties (slug, name_fr, name_ar) VALUES (?, ?, ?)').run(slug, fr, ar);
  }
  const methods = [
    ['baridimob', 'BaridiMob', 'بريدي موب'],
    ['cash', 'Espèces (cabinet)', 'نقدا في العيادة'],
    ['free', 'Gratuit', 'مجاني'],
  ];
  for (const [slug, fr, ar] of methods) {
    dbConn.prepare('INSERT OR IGNORE INTO payment_methods (slug, name_fr, name_ar) VALUES (?, ?, ?)').run(slug, fr, ar);
  }

  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const server = http.createServer(handle);
  server.listen(port, host, () => {
    console.log(`[medirdv-central] Patient platform: http://${host}:${port}/`);
    console.log(`[medirdv-central] Admin dashboard:  http://${host}:${port}/admin/`);
    console.log(`[medirdv-central] WhatsApp Hub: ${whatsapp.isPlatformConfigured() ? 'configured (official Cloud API)' : 'DISABLED (click-to-chat fallback only)'}`);
  });

  // Expiry sweeper: pending bookings past their deadline expire (Part 6.2).
  const sweeper = setInterval(() => {
    try {
      booking.expireStaleBookings(new Date().toISOString());
    } catch (error) {
      console.error('[medirdv-central] expiry sweeper failed:', error.message);
    }
  }, 60 * 1000);
  sweeper.unref();
  return server;
}

if (require.main === module) start();

module.exports = { start, handle };
