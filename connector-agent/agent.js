'use strict';
/**
 * Medirdv Central — optional desktop sync agent (reference implementation).
 *
 * Runs on the doctor's PC next to MediRDV / DentaRDV. Polls Central's
 * connector API and maps Central bookings to the local SQLite schema.
 * Never modifies the desktop apps themselves.
 *
 * Usage:
 *   CENTRAL_URL=https://central.medirdv.dz DEVICE_ID=pc-1 DEVICE_TOKEN=... \
 *   LOCAL_DB_PATH=/path/to/medirdv.sqlite node agent.js
 *
 * Requires: better-sqlite3 (same major as the desktop app).
 */
const Database = require('better-sqlite3');

const CENTRAL_URL = process.env.CENTRAL_URL || 'http://localhost:8080';
const DEVICE_ID = process.env.DEVICE_ID || '';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const LOCAL_DB_PATH = process.env.LOCAL_DB_PATH || '';
const POLL_MS = Number(process.env.POLL_MS || 60000);

if (!DEVICE_ID || !DEVICE_TOKEN || !LOCAL_DB_PATH) {
  console.error('Set DEVICE_ID, DEVICE_TOKEN and LOCAL_DB_PATH.');
  process.exit(1);
}

const db = new Database(LOCAL_DB_PATH);
db.pragma('foreign_keys = ON');

async function api(path, options = {}) {
  const res = await fetch(`${CENTRAL_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': DEVICE_ID,
      'X-Device-Token': DEVICE_TOKEN,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Pull pending central items and apply them locally (idempotent). */
async function pull() {
  const { items } = await api('/api/v1/connector/sync/pull');
  const ack = [];
  for (const item of items) {
    try {
      const payload = JSON.parse(item.payload || '{}');
      if (item.kind === 'booking_confirmed' && payload.ref) {
        // Map Central booking -> local queue appointment if not present.
        const exists = db.prepare(
          'SELECT id FROM appointments WHERE notes LIKE ? LIMIT 1'
        ).get(`%${payload.ref}%`);
        if (!exists && payload.patient_id) {
          db.prepare(
            'INSERT INTO appointments (patient_id, day, queue_number, status, source, notes) ' +
            'VALUES (?, ?, 1, ?, ?, ?)'
          ).run(payload.patient_id, payload.date || '', 'booked', 'manual', `central:${payload.ref}`);
        }
      }
      ack.push(item.id);
    } catch (err) {
      console.error(`failed to apply sync item ${item.id}:`, err.message);
    }
  }
  if (ack.length) await api('/api/v1/connector/sync/ack', { method: 'POST', body: JSON.stringify({ ids: ack }) });
}

/** Push local changes (e.g. conflicts) to Central. */
async function pushConflicts() {
  const rows = db.prepare(
    "SELECT id, day, queue_number FROM appointments WHERE status = 'booked' LIMIT 50"
  ).all();
  for (const row of rows) {
    await api('/api/v1/connector/sync/push', {
      method: 'POST',
      body: JSON.stringify({ kind: 'local_appointment', payload: { local_id: row.id, day: row.day } }),
    });
  }
}

async function tick() {
  try {
    await api('/api/v1/connector/heartbeat', { method: 'POST', body: '{}' });
    await pull();
    await pushConflicts();
  } catch (err) {
    console.error('sync tick failed (will retry):', err.message);
  }
}

console.log(`Medirdv sync agent started (device ${DEVICE_ID}, poll ${POLL_MS}ms)`);
tick();
setInterval(tick, POLL_MS);
