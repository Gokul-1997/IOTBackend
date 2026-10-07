# Multi-company tests

Several companies of different sizes on one stack at once: onboarding through
the API, a cross-company isolation probe of every route, and combined load
(machines publishing, portal users, live-data sockets, scheduled jobs).
Runs against the **local** stack of `../README.md` — never production.

| Step | Command | What it does |
|---|---|---|
| Database | `CREATE DATABASE iot_mt TEMPLATE iot_rehearsal` | a copy of production's schema and configuration with migrations 035–038 |
| Companies | `node setup.mjs --out mt.json` (then `--companies D` adds a fourth, 160-machine company to the same file) | S&T creates A (20 machines, Bronze), B (50, Silver), C (70, Silver) and their admins; each admin creates a plant, three shifts, machines, components, running jobs, operators and users. Every name carries the company's marker (ZZA / ZZB / ZZC) |
| Records | `node objects.mjs --in mt.json` | one of each record a company owns (line, ticket, schedules, maintenance log, downtime reason and event, quality entry, threshold, periodic schedule, energy settings, device token, alarm, notification) |
| History | `psql -v companies='11,12,13' -f history.sql` | 14 days of hourly production, the last 6 hours of 1 Hz telemetry, alarms |
| Isolation | `node probe.mjs --in mt.json --writes` | every route as company A with company B's ids (see below) |
| Machines | `node fleet.mjs --in mt.json --seconds 300 [--outage C:60:240] [--reconnect-at 120]` | every machine at one reading a second, latency and loss per company |
| Users | `node load.mjs --in mt.json --seconds 300 [--mode stress] [--heavy C --heavy-users 10]` | every user signed in with a live-data socket; latency per company; foreign socket messages counted |
| Resources | `node sample.mjs --seconds 300 --api-pid … --collector-pid … --pgdata …` | CPU, memory, database connections, journal backlog, gateway lag |
| Totals | `node accuracy.mjs snapshot …` before a fleet run, `compare --from … --to …` after | each company's hourly run, idle and parts against its readings |

Results of 7 Oct 2026: `docs/MULTI_COMPANY_RESULTS_2026-10-07.md`.

`setup.mjs` and `objects.mjs` refuse any database not named `iot_mt*` on
localhost: they set test passwords directly in the database.

## The isolation probe

For every route in `src/routes.js`, as company A's admin and as an A user:

- **reads** — a reply leaks if it carries B's marker, or (for replies without
  names) if it is the same as B's own admin gets for the same request and
  holds data. Each GET is asked with today's and yesterday's date.
- **writes** (`--writes`) — B's rows in every table with a `company_id` or a
  `machine_id` are fingerprinted before and after each request; any change is
  a cross-company write. Afterwards, rows of one company pointing at another
  company's machine, shift, component or operator are counted.
- every route without a token must answer 401.

It changes B's data when a write leaks: rebuild the database after a run that
found something.
