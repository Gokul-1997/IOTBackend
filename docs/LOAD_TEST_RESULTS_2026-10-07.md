# Load and reliability test results — 7 Oct 2026

Local copy of production (see `tools/loadtest/README.md`). One 8-core / 8 GB laptop ran the database, Redis, broker, services and load generators together, so absolute numbers are conservative for a server; the before/after comparison is like for like.

## Baseline (current code: pms-backend 468d731, Backend 47963e5) on the local staging stack
Stack: PostgreSQL 18.3 + TimescaleDB 2.30.2 (prod: 14.21 + 2.19.3), Redis 8, Mosquitto 2.1.2 with default queue limits, all on one 8-core / 8 GB laptop.
Data: production schema + all production config tables + 2 days of real telemetry (17 machines) + LOADTEST company: 100 machines, 24 h of 1 Hz telemetry (8.64 M rows, 2.7 GB), 30 days of hourly production.

## Ingestion (100 machines × 1 msg/s)
| Scenario | Published | Stored | Lost | Publish→DB p50 / p95 / max |
|---|---|---|---|---|
| Sustained 180 s | 18,000 | 18,000 | 0 | 455 / 987 / 1,063 ms |
| Collector restart, 15 s down | 10,000 | 9,400 | 600 (6 %) | 728 / 12,232 / 16,234 ms |
| Database down 30 s | 10,000 | 10,000 | 0 raw rows; 3,100 hourly-production updates failed and were dropped | 883 / 26,499 / 30,503 ms |

Collector: ~3 % of one core, 100 MB RSS at 100 msg/s.

## Portal (API, 100 users)
| Scenario | Requests | req/s | Errors | p50 / p95 / p99 |
|---|---|---|---|---|
| Realistic browsing, 5 min | 935 | 2.5 | 0 | 22 / 206 / 1,115 ms |
| Stress (1 s think), all users on one address | 13,766 | 113.8 | 95 % (2,807+ ×429 rate limit, ~350 ×500 pool timeouts) | — |
| Stress (1 s think), one address per user | 4,352 | 35.2 | 26 % (all 500: "timeout exceeded when trying to connect", pool max 10) | 2,019 / 7,035 / 9,358 ms |

Slowest endpoint: /api/dashboard/energy (7-day range) p50 1.1 s, max 2.0 s in the realistic run.


## Ingestion: baseline (468d731) vs new collector — 100 machines × 1 msg/s, local staging stack
| Scenario | Baseline | New |
|---|---|---|
| Sustained 180 s (18,000 msgs) | 0 lost; publish→DB p50 455 / p95 987 / max 1,063 ms | 0 lost; p50 46 / p95 72 / max 118 ms |
| Collector restart 15 s, broker defaults (max_queued_messages 1000) | 600 lost (6 %) | 600 lost (6 %) — dropped by the broker's queue limit, not the collector |
| Collector restart 15 s, broker tuned (max_queued_messages 100000) | 0 lost* | 0 lost, 0 duplicates |
| 10 × kill -9 at random moments, 140 s (14,000 msgs) | 900 lost (6.4 %) | 0 lost, 0 duplicates |
| Hourly production through the 10 crashes | (not exact: in-memory rollups lost on each crash) | exact: 13,900 machine-seconds = 100 × 139 |
| Database down 30 s | 0 raw rows lost; 3,100 hourly-production updates failed and were dropped | 0 rows lost; hourly exact (9,900 = 100 × 99 machine-s); written within 1 s of the DB returning |
| Burst: 120 s of backlog from every machine at once (12,000) + live | all stored; p50 457 / p95 1,022 ms | all stored; p50 42 / p95 71 / max 680 ms |
| Out-of-order + duplicate readings (40 sent to 10 machines) | 20 stored, 10 out-of-order silently discarded | 20 stored, 10 out-of-order kept in telemetry_late (reason recorded), duplicates counted |
| Run/idle double count (runtime-flush) | +~100 % run & idle time | removed: one writer |

CPU ≈ 3 % of a core and ~95 MB RSS at 100 msg/s for both.
*single trial; the 10-crash run shows the baseline's per-crash loss.


## Portal API: baseline (Backend 47963e5, production's indexes) vs new (pool 20, per-user rate limits, migrations 035–037)
Same staging data: 100-machine LOADTEST company (24 h of 1 Hz telemetry, 30 days hourly) + production config.

| Scenario | Baseline | New |
|---|---|---|
| 100 users browsing 5 min, one factory address | 935 req, 0 errors; p50 22 / p95 206 / p99 1,115 ms | 1,003 req, 0 errors; p50 20 / p95 128 / p99 147 ms |
| Stress (1 s think), 100 users, one address | 95 % refused (429 rate limit + 500 pool timeouts) | 12,951 req at 107 req/s, 0 errors; p50 138 / p95 758 / p99 1,203 ms |
| Stress, one address per user (no rate limit in the way) | 35 req/s, 26 % errors (all pool timeouts); p50 2,019 / p95 7,035 / p99 9,358 ms | (above: 107 req/s, 0 errors) |
| Energy dashboard, 7-day range, one request | 0.88–1.1 s | 8 ms (two partial indexes) |
| Live dashboard / machine page / timeline (single request) | 6 / 5 / 5 ms | 5 / 5 / 5 ms (unchanged) |
