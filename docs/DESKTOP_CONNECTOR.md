# Desktop Connector — MediRDV / DentaRDV (Part 7)

## Inspection findings (existing apps — NOT modified)
- Both apps are Electron + `better-sqlite3`, IPC-only (no HTTP API).
- Appointment model: queue numbers per department/day (not time slots).
- WhatsApp: Baileys (unofficial) — Central does not reuse this transport.
- Local DB: single SQLite file under the user profile (`data/`).

## Architecture
Central exposes a device-authenticated REST sync API; an **optional
lightweight agent** (`connector-agent/agent.js`, Node, reference
implementation) runs on the doctor's PC, polls Central, and maps between
Central bookings and the local SQLite schema. Central keeps working when
the doctor's PC is offline — the agent queues outbound changes in its own
outbox and syncs on reconnect.

### Central API (`/api/v1/connector/*`)
- `POST /register` `{doctor_id, device_id, app_kind}` → one-time `{token}`
- `POST /heartbeat` — liveness; `last_seen` updated
- `POST /sync/push` `{kind, payload}` — desktop → central (queued)
- `GET /sync/pull` — central → desktop pending items
- `POST /sync/ack` `{ids}` — mark delivered

### Status distinction (never conflated)
`booking received` → `doctor notified` → `appointment accepted` →
`synchronized to desktop`. Each transition is an `appointment_events` row.

### Conflict detection
- Central slot uniqueness (partial unique index) is authoritative.
- If the desktop already holds a conflicting local appointment for the same
  doctor/day/time, the agent reports it via `sync/push` with
  `kind=conflict` and Central logs it in `integration_logs` for admin review.
  No silent overwrites.

## Installing the agent (optional)
1. On the doctor's PC: `npm install better-sqlite3` (same version as the app).
2. Copy `connector-agent/agent.js`, set `CENTRAL_URL`, `DEVICE_ID`, `DEVICE_TOKEN`,
   `LOCAL_DB_PATH` (path to the app's SQLite file).
3. Run: `node agent.js` (or register as a Windows service via `nssm`).
4. Register the device from Central admin first to obtain the token.

The agent only touches the local DB through the app's own schema; it never
rewrites the desktop apps.
