# Load and reliability tests

Used on 7 Oct 2026 to measure the collector and the API before and after the
production-readiness changes (results: `docs/LOAD_TEST_RESULTS_2026-10-07.md`).
Everything runs against a **local copy** — never against production.

## The local stack

| Service | Port | How |
|---|---|---|
| PostgreSQL 18 + TimescaleDB 2.30 | 55432 | a separate `initdb` cluster with `shared_preload_libraries = 'timescaledb'` |
| Redis | 56379 | `redis-server --port 56379 --save "" --appendonly no` |
| Mosquitto | 51883 | default queue limits first, then `pms-backend/deploy/mosquitto.conf` values |
| Collector | health 59100 | `DB_*`, `REDIS_*`, `MQTT_URL`, `JOURNAL_DIR` pointed at the above |
| API | 58000 | `POSTGRESQL_*`, `REDIS_URL`, a test `JWT_SECRET`; run from a folder with **no** `.env` |

Database: production's schema (`pg_dump --schema-only --schema=public`, minus the
continuous-aggregate view), `create_hypertable` for `telemetry_raw` (1 day) and
`energy_meter_readings` (7 days), production's small tables (`pg_dump --data-only`
excluding telemetry), a few days of telemetry (`\copy (SELECT …) TO STDOUT` per day),
`prod_like_roles.sql` (the collector's role and grants as in production), then
`loadtest_fixture.sql` (company 900: 100 machines, 3 shifts, a 60 s component) and
optionally `loadtest_history.sql` (24 h of 1 Hz telemetry, 30 days hourly).

## Tests

```bash
node simulate.mjs --machines 100 --seconds 180 --tag sustained          # loss + publish→DB latency
node simulate.mjs --machines 100 --seconds 60 --burst 120               # every machine flushes 2 min of backlog
node order.mjs                                                          # out-of-order + duplicate readings
node apiload.mjs --users 100 --seconds 300 --mode realistic --machines '[80,81,…]'
node apiload.mjs --users 100 --seconds 120 --mode stress --users-file users.json   # one account per user
```
Faults, during a `simulate.mjs` run: stop the collector (`kill -TERM`, restart after
15 s), crash it (`kill -9` at random moments), stop the database
(`pg_ctl stop -m fast`, start after 30 s). `simulate.mjs` reconciles every published
reading against `telemetry_raw` at the end and prints `RESULT {…}`.
