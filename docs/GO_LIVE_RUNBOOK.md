# Go-live runbook — production readiness changes of 7 Oct 2026

What ships, in what order, how to check each step, and how to undo it.
Rehearsed end to end on a copy of production (schema, all configuration
tables, recent telemetry, the collector's database role and its grants).

| Repo | What changed |
|---|---|
| pms-backend | Journal + exactly-once writer; runtime-flush removed (run/idle double count); shifts in memory; late / out-of-order readings kept; graceful stop; `/metrics` per outcome |
| Backend | Live data per company (Socket.IO); rate limits per user and on the real login path; no SQL text in 500s; login enumeration closed; crons single-runner + `CRON_ENABLED`; hourly OEE on IST hours; pool 20; `/health/ready`; migrations 035–038; correction script; backup scripts |
| FrontendIOT | Live updates reconnect indefinitely; Angular 21.2.25 (security fixes) |

## 0. Before you start

- [ ] **Backup** and **check it restores** (section 6). Note the dump file name.
- [ ] Broker settings: merge `pms-backend/deploy/mosquitto.conf` into the broker's config and reload it. Without `max_queued_messages` the broker drops readings when the collector restarts for more than ~10 s.
- [ ] Rotate `JWT_SECRET` to 48+ random characters (`openssl rand -base64 48`) in Backend `.env` (it is 22 today). Everyone signs in once more afterwards: the live-data connection treats a token signed with the old secret as invalid. Do it at go-live.
- [ ] On every machine that is not the production API server (developer laptops pointed at production): `CRON_ENABLED=false` in its `.env`.
- [ ] Quiet window for step 4 (index changes): writes to telemetry wait a few seconds per chunk; the collector's journal holds them.

## 1. Migration 035 (additive — required before the new collector)

```bash
cd Backend && npm ci && npm run migrate -- --dry   # lists 035–038 as PENDING
npm run migrate                                     # applies 035 … 038 in order
```
To apply only 035 first, move 036–038 aside or run the file directly with psql.
Check: `SELECT * FROM ingest_checkpoint;` exists (empty); `\d telemetry_late`.

## 2. Collector (pms-backend)

```bash
cd pms-backend && git pull && npm ci
mkdir -p data/journal                      # or set JOURNAL_DIR (persistent disk)
pm2 reload ecosystem.config.cjs --env production
curl -s localhost:${HEALTH_PORT:-3001}/health | jq '.status, .journal, .writer, .outcomes'
```
Expect within a minute: `status: ok`, `writer.db_ok: true`, `journal.pending` near 0,
`outcomes.accepted` rising. The collector refuses to start if 035 is missing — it
logs the missing tables and exits; the broker keeps the messages meanwhile.

**Rollback:** `git checkout <previous commit>`; `pm2 reload`. Readings already in the
journal are written by the new build only — let `journal.pending` reach 0 first.

## 3. API (Backend) and web app

```bash
cd Backend && git pull && npm ci --omit=dev && pm2 reload ecosystem.config.js --env production
curl -s https://stmapi.stmcnc.com/health/ready     # {"ok":true,"db":true,"redis":true,…}
cd FrontendIOT && git pull && npm ci && npx ng build --configuration production   # deploy dist/
```
Check: sign in; Live Dashboard updates without reload; a second company's user does
not see the first company's machines (covered by `__tests__/integration/socket.tenant-isolation.test.js`).

## 4. Migrations 036–037 (quiet window) and 038

Applied by `npm run migrate` in step 1 if you ran it whole. Expected durations on
production (7.8 GB of telemetry): 036 ≈ 1–3 min (two small partial indexes built chunk
by chunk; three unused indexes dropped, ~5.6 GB freed), 037 instant (compression runs
in the background on chunks older than 7 days — first pass may take tens of minutes),
038 instant.

Check after 037 (next hours): `SELECT * FROM chunk_compression_stats('telemetry_raw');`

| Undo | Command |
|---|---|
| 038 | `psql -f src/migrations/rollback/038_collector_least_privilege_down.sql` |
| 037 | `psql -f src/migrations/rollback/037_telemetry_compression_down.sql` (needs the disk space back) |
| 036 | `psql -f src/migrations/rollback/036_telemetry_indexes_down.sql` |
| 035 | stop the new collector first; `psql -f src/migrations/rollback/035_ingest_journal_down.sql` |

## 5. Correct the double-counted run/idle time (after step 2 is live)

```bash
cd Backend
node scripts/fix-hourly-double-count.js            # report only: rows, hours, ratios
node scripts/fix-hourly-double-count.js --apply    # backs up, deletes, recomputes OEE roll-ups
```
Run it on the API server (≈ 40,000 small queries; minutes there, much longer over the
internet). It prints run hours by day, telemetry vs reports: ratios go from ~2.0 to ~1.0.
Everything it deletes or overwrites is kept in `fix_20261006_*` tables;
`--rollback` restores them exactly. **Tell users first:** historic availability and
downtime in reports drop to their true values (e.g. a machine at 61 % availability for
5 Oct shows 25 %).

## 6. Backups

```bash
PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=iot BACKUP_DIR=/var/backups/iot S3_URI=s3://…/iot-db/ \
  Backend/scripts/ops/db-backup.sh                         # nightly, from cron
Backend/scripts/ops/db-restore-test.sh /var/backups/iot/iot_<stamp>.dump iot_restore_test   # weekly
```
The restore test needs the same TimescaleDB version (2.19.3 today). Point-in-time
recovery needs WAL archiving (pgBackRest or wal-g) — not configured today
(`archive_mode = off`), so the worst case today is losing everything since the last dump.

## 7. Monitoring to set up

| Signal | Where | Alert when |
|---|---|---|
| Collector up and writing | `GET :3001/health` | not 200 for 2 min |
| Readings waiting | `/metrics` `pms_journal_pending` | > 6,000 (≈ 1 min at 100/s) for 5 min |
| Database writes | `pms_writer_db_ok` | 0 for 1 min |
| Readings refused | `pms_journal_refused_total`, `pms_messages_journal_refused_total` | increases |
| Late readings | `pms_messages_late_stale_total` | rises fast (a gateway publishing late) |
| API | `GET /health/ready` | not 200 for 2 min |
| DB disk | host | > 80 % |
| Backups | backup log | no "backup ok" in 26 h |
