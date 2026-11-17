# Medirdv Central — Deployment Guide (Phase 10)

## 1. Requirements

- Node.js **22+** (uses the built-in `node:sqlite`; no native modules to compile).
- A Linux server (Ubuntu 22.04/24.04 LTS recommended), 1 vCPU / 1 GB RAM is
  enough for a few hundred bookings per day.
- HTTPS terminating proxy (Caddy, Nginx + certbot, or a cloud LB). **Never**
  expose the Node port directly on the public internet without TLS.

## 2. First deployment

```bash
# 1. Get the code
git clone <repo> medirdv-central && cd medirdv-central

# 2. Configure
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # MEDIRDV_ENCRYPTION_KEY
${EDITOR:-nano} .env      # set key, bootstrap admin, public URL

# 3. Run (foreground test)
npm start

# 4. Verify
curl -fsS http://127.0.0.1:8080/health
```

Open `https://<your-domain>/admin/` and log in with the bootstrap admin, then
**immediately change the password** (create a second super admin first, if you
prefer not to lock yourself out).

## 3. Run as a service (systemd)

`/etc/systemd/system/medirdv-central.service`:

```ini
[Unit]
Description=Medirdv Central
After=network.target

[Service]
Type=simple
User=medirdv
WorkingDirectory=/opt/medirdv-central
EnvironmentFile=/opt/medirdv-central/.env
ExecStart=/usr/bin/node --no-warnings src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/medirdv-central/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now medirdv-central
sudo journalctl -u medirdv-central -f
```

## 4. Reverse proxy (Caddy, TLS automatic)

```
central.example.dz {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Caddy obtains and renews Let's Encrypt certificates automatically. If you use
Nginx, mirror this with `proxy_pass http://127.0.0.1:8080;` plus
`proxy_set_header X-Forwarded-For $remote_addr;`.

## 5. Database migrations

Migrations are **append-only** and run automatically on startup
(`src/schema.js`, `schema_migrations` table tracks the applied version).

- Upgrading: stop service → back up `data/` → deploy code → start service.
- Migrations never drop or delete business rows; they only add tables,
  columns, and indexes.
- Check the applied version:
  ```bash
  sqlite3 data/medirdv-central.sqlite 'SELECT * FROM schema_migrations;'
  ```

## 6. Backups and recovery

Backups must be taken with SQLite's online backup API (a plain `cp` during a
write can be inconsistent):

```bash
# Nightly backup (cron)
sqlite3 data/medirdv-central.sqlite ".backup '/backups/central-$(date +%F).sqlite'"
tar czf /backups/receipts-$(date +%F).tgz -C data receipts
find /backups -name 'central-*.sqlite' -mtime +30 -delete
```

Restore:

```bash
sudo systemctl stop medirdv-central
cp /backups/central-YYYY-MM-DD.sqlite data/medirdv-central.sqlite
rm -f data/medirdv-central.sqlite-wal data/medirdv-central.sqlite-shm
sudo systemctl start medirdv-central
```

Test a restore **before** going live, and keep at least 30 days of backups
plus monthly off-site copies.

## 7. Environment separation

| Env | Database | WhatsApp | Notes |
|---|---|---|---|
| dev | `./data/dev.sqlite` | not configured | `npm run seed-demo` for sample data |
| staging | `./data/staging.sqlite` | Meta test app + test number | full rehearsal of releases |
| prod | `./data/medirdv-central.sqlite` | live Meta app | real money verification, real patients |

Never reuse the production `MEDIRDV_ENCRYPTION_KEY` or admin password in
staging, and never copy production patient data into staging.

## 8. Scaling notes

- One process handles thousands of bookings/day comfortably.
- To scale horizontally later, migrate SQLite → PostgreSQL (queries are plain
  SQL; `node:sqlite` calls are isolated in `src/db.js`, so the swap is
  contained) and move the expiry sweeper to a single job runner.
- Receipts are stored on disk (`MEDIRDV_RECEIPTS_DIR`); mount that path on
  shared storage or object storage before adding app servers.
