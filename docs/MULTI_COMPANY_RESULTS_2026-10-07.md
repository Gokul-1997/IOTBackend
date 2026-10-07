# Multi-company tests — 7 Oct 2026

Several companies on one stack at once: isolation of every route, combined
load, one company misbehaving, reconnects, and whether each company's hourly
totals stay exact. Tools and procedure: `tools/loadtest/multitenant/README.md`.

**Stack.** One 8-core / 8 GB laptop ran PostgreSQL 18 + TimescaleDB 2.30
(production: 14.21 + 2.19.3), Redis, Mosquitto, the API, the collector and the
load generators together, so absolute numbers are conservative for a server.
The database is a copy of production's schema and configuration (migrations
001–038).

**Companies**, onboarded through the API exactly as a customer is (S&T creates
the company and its admin; the admin creates plant, shifts, machines,
components, jobs, operators, users):

| Company | Plan | Machines | Users signed in | In runs |
|---|---|---|---|---|
| A | Bronze | 20 | 10 | all |
| B | Silver | 50 | 36 | all |
| C | Silver | 70 | 50 | all |
| D | Gold | 160 | 21 | capacity run only |

Every machine publishes one reading a second (`fleet.mjs`, one MQTT connection
each). Every user has a live-data socket and browses the way the web app
refreshes (`load.mjs`); scheduled jobs (shift and hourly OEE, preventive and
periodic engines) run as in production.

## Isolation — every route, company A asking with company B's ids

| | Before (`71349f0`) | After (`b0ca586`) |
|---|---|---|
| Reads that returned B's data | 3 — quality dashboard, hourly chart, part timing | 0 |
| Writes that changed B's data | 9 — quality entry, component (rewrote B's running job), operator create and update, two assignments, ticket, maintenance schedule, downtime event | 0 |
| Records left pointing at another company's machine, shift, component or operator | 10 | 0 |
| Routes answering without a token | 0 | 0 |
| Live updates delivered to another company's socket, under load | — | 0 in every run (0.9–2.3 M messages each) |

## Load

| Run | Readings/s | Users | Readings lost / duplicated | Publish → stored, p95 | Portal requests / errors | Portal p95 by company | Sockets: messages / foreign |
|---|---|---|---|---|---|---|---|
| Combined, 300 s | 140 | 96 | 0 / 0 of 42,000 | 73–78 ms | 1,223 / 0 | A 60, B 74, C 84 ms | 1.60 M / 0 |
| Stress (1 s between clicks), 180 s | 140 | 96 | 0 / 0 of 25,200 | 75–82 ms | 24,801 (133/s) / 0 | A 128, B 146, C 157 ms | 0.94 M / 0 |
| Capacity, four companies, 240 s | 300 | 117 | 0 / 0 of 72,000 | 81–98 ms | 1,293 / 0 | A 52, B 136, C 95, D 44 ms | 2.03 M / 0 |

Capacity run resources: API 9 % of a core on average (peak one core), collector
4 %, PostgreSQL 11 % (peak 0.9 core), at most 52 database connections (API 20,
collector up to its pool of 30).

## One company misbehaving

Company C's gateway lost its link for 240 s and then sent its 16,800 buffered
readings at once; from 60 s to 360 s, 12 of C's users pulled exports and
reports back to back, no pause.

| | Without a limit | With the per-company limit (`68ab12e`) |
|---|---|---|
| A dashboards p95 / max during C's reporting | 480–1,200 ms / 1.2 s | 60–270 ms / 0.27 s |
| B dashboards p95 / max | 450–2,030 ms / 3.1 s | 120–310 ms / 0.39 s |
| C's own dashboards p95 | 630 ms | 180 ms |
| C's heavy requests served (300 s) | 9,547 | 7,981 (waiting their turn, none refused) |
| Errors anywhere | 0 | 0 |
| A and B ingestion p95 in the 30 s after C's burst | 82–84 ms | 79 ms |
| C's ingestion, 30 s after its burst | p95 508 ms, max 1.2 s | p95 340 ms, max 1.2 s |

The limit: exports, reports, PDFs, part timing and the spindle panel over 12 h
or 24 h run at most 3 at a time per company and 8 in all (`HEAVY_PER_COMPANY`,
`HEAVY_OVERALL`), the rest wait up to 30 s.

## Reconnects (240 s, 140 readings/s, 96 users)

Every machine connection dropped at 60 s; the API restarted at 100 s; the
collector restarted at 150 s. 33,600 readings, 0 lost, 0 duplicated
(publish → stored max 2.5 s, during the collector restart). Every socket
reconnected by itself (96 → 192 connects); 23 portal requests failed during the
two seconds the API was down, none after.

## Hourly totals while four companies publish at once

The capacity run's hourly production compared with what the readings
themselves say (`accuracy.mjs`), per company:

| Company | Run seconds | Idle seconds | Parts | Agree |
|---|---|---|---|---|
| A | 3,980 | 800 | 80 | yes |
| B | 9,950 | 2,000 | 200 | yes |
| C | 13,930 | 2,800 | 280 | yes |
| D | 31,840 | 6,400 | 640 | yes |

## Single requests per company size (idle, warm)

| Endpoint | A (20) | B (50) | C (70) |
|---|---|---|---|
| Live dashboard | 21 ms | 6 ms | 7 ms |
| Factory | 98 ms | 147 ms | 178 ms |
| Maintenance | 142 ms | 210 ms | 176 ms |
| Machine page | 72 ms | 37 ms | 55 ms |
| OEE, 7 days | 10 ms | 28 ms | 75 ms |

The first requests after a cold start were slower (up to 1.8 s for Factory),
while PostgreSQL loaded the recent telemetry into memory.
