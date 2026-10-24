# Platform audit and implemented fixes — 24 October 2026

The verified code fixes are implemented across the API, collector, web and mobile repositories. Existing business workflows and the design system are preserved. Local automated checks pass, including actual PostgreSQL/MQTT integration fixtures and browser flows. **This is not approval for production deployment:** the configured database connection, high-fleet ingestion capacity, remaining mobile tooling advisories and hardware/deployment verification still need the actions below.

## Scope and evidence

The discovery inventory contains 1,008 accessible source, configuration, asset, documentation and historical-data paths: Backend 432, FrontendIOT 395, MobileApp 91, pms-backend 66, and 24 other workspace paths. Generated dependencies, Git internals and build caches were excluded. PMS lives in the main API's jobs/components/operators/quality modules and Angular screens; `pms-backend` is the telemetry collector.

Inventory coverage is not a claim that every line or historical dataset received exhaustive semantic review. Review and executable checks concentrated on authentication, tenant/plant boundaries, reports, live subscriptions, PMS integrity, telemetry durability, gateway transfer, lifecycle cleanup and deployment configuration. Historical backups and documents were retained; no data reset, publishing, deployment, paid-service signup or controller operation was performed.

[Evidence folder](audit/2026-10-24/verification.json) contains repository heads/change paths, check summaries and hashes of the original execution logs. Adjacent files contain benchmark JSON, current dependency audits, a sanitized database summary, source inventory and compact log extracts. Extracts are labelled as such; full transient logs were not represented as complete archived logs.

## Priorities and implemented changes

| Priority | Finding and resulting behavior | Main files | Verification |
| --- | --- | --- | --- |
| P1 security | Authenticated notification-only users could join machine feeds without dashboard permission. Socket data rooms now require the same matching role and company page access as the dashboard APIs. Private notification rooms remain available. | `src/lib/socket-server.js`, `src/middleware/access.middleware.js` | Socket tenant tests, real PostgreSQL authorization/plant fixtures, 100 authenticated benchmark sockets |
| P1 integrity | A gateway could change an already completed transfer's result or report a removed file. The first result is now final; exact retries are idempotent, conflicting results and removed files return 409. | `src/programs/program.service.js` | Report-finality tests, device/gateway regression suites |
| P1 safety | Gateway HTTP calls had no whole-response deadline or bounded download. Calls now cancel on timeout/stop, reject redirects, cap response/program bytes and release cancellation listeners. Parallel ticks share one round. | `tools/gateway/mexa-gateway.js` | Header/body stalls, abort, oversized response, overlapping tick and listener-cleanup tests |
| P1 safety | Folder transfers could overwrite the only previous program and collide on staging names. A previous version plus SHA-256 metadata is saved privately and flushed before replacement. Unique staging, read-back checks, size limits and ambiguous-folder rejection protect the existing folder workflow. Existing DNC file permission bits are preserved; new files use the service account's umask. | Same gateway, gateway README, Program Transfer API guide | Actual temporary-file overwrite/retry/backup-failure/mode/collision tests; 12 browser scenarios |
| P1 integrity | Invalid negative/fractional/nonfinite/type-mismatched counters could disturb the production baseline. Counters now match the database INT4 range, invalid observations do not count production or replace the last valid baseline. | Collector `parts-delta.js`, `message-processor.js` | Invalid-counter/recovery tests plus collector suite and actual SQL ingestion fixture |
| P1 reliability | Shutdown's forced deadline was armed after awaited cleanup and could never be reached. It now starts immediately, stays armed even if no other handle remains, and handles repeated signals/startup failure through one shutdown path. | `src/server.js` | Actual server source exercised with a deliberately hung dependency |
| P2 performance | Parallel health checks could accumulate probes and deadline timers. Probes coalesce, cache briefly, retain at most one underlying operation and one deadline race per dependency, and recover when it completes. | New `src/lib/readiness.js`, `src/app.js` | 100 concurrent checks, permanently hung dependencies, timer cleanup and recovery |
| P2 performance | Login/company creation used bcryptjs while other account code already used native bcrypt. These callers now share native bcrypt, preserving hashes and cost; bcryptjs was removed. Telemetry fingerprinting runs once per packet instead of three times. | Auth/company services, load-test setup, collector processor | Full API suite, old/new hash compatibility, measured hashing/admission comparisons |
| P2 privacy | Some notification/audit/operator-report error responses exposed raw internal exceptions. They now use the existing shared error formatter, preserving expected client errors and hiding server details. | Three controllers | API/service/security regression suites |
| P2 mobile | SecureStore errors or malformed cached profiles could leave startup stuck. Bootstrap now exits to sign-in safely and ignores stale session completions; unmount prevents a late readiness state update. | `src/store/authStore.ts`, `App.tsx` | Six additional bootstrap cases, TypeScript, all mobile tests and Expo export |
| P2 cleanup | Push-registration code had no callers and referenced a backend endpoint which does not exist. Removed that scaffold, `expo-device`, `expo-notifications` and the unused notifications plugin configuration. In-app notifications continue through their existing API/socket path. | Mobile `src/api/pushNotifications.ts`, manifests | Reference search, type check, tests and export |
| P2 web | A distant JWT expiry could overflow the browser's signed 32-bit timer and refresh immediately. Refresh scheduling now bounds the delay and reevaluates distant expiries. | Web `auth.service.ts` | Long-expiry fake-clock test and browser sessions |
| P2 isolation | Development pointed at the deployed API; HTTP-mocked tests did not block actual WebSockets. Development now proxies HTTP/socket traffic locally; auth fixtures close test sockets. Specialized fixture origin checks accept the configured loopback server and refuse nonlocal origins. | Web environment/proxy, E2E fixtures | Browser assistant, dashboard, admin, jobs and program-transfer checks |
| P2 verification | Shared PostgreSQL fixtures lacked current machine/program columns, report parameters and backup permissions. Angular could also load two copies of the socket test registry across chunks. Fixtures now match the current contract and share the registry within a test environment. | Two architecture tools, web test helper | Real plant/PMS fixtures and complete web unit suite |
| P2 maintenance | Mobile had no checked-in CI workflow or Node selector. Added Node 24 selection and clean install/typecheck/test/web-export CI. Existing API/web/collector CI remains. | Mobile `.nvmrc`, `.github/workflows/ci.yml` | Commands executed locally; hosted GitHub Actions execution remains a deployment check |

No new infrastructure, microservice split or database schema rewrite was justified by these findings. Keep the modular API, separate durable collector, existing Redis cache/fanout and PostgreSQL/TimescaleDB. The ingestion bottleneck needs measured storage/admission work, rather than an unrelated application rewrite.

## Database review

The configured database was inspected with a database-enforced `READ ONLY` transaction and statement/connect deadlines. Only catalog, extension, migration-ledger, policy and storage metadata was read. No customer rows were exported or changed.

- PostgreSQL **14.21**, TimescaleDB **2.19.3**; 70 public relations in the inventory and 822 columns. All **56 nonretired migration checksums match** the current source. The retired destructive reset is not executed by the migration runner.
- `telemetry_raw`: 228 chunks, one-day time dimension, compression enabled with a scheduled compression policy. `energy_meter_readings`: four chunks, seven-day interval, no compression. Whole database size was about **2.28 GB** at inspection; this includes chunks, unlike parent-table sizes alone.
- No telemetry retention policy is configured. Job-history retention is a separate Timescale internal policy. Retention needs an agreed business/audit window and a verified restore before any deletion policy is enabled.
- A legacy `production_hourly_mv` continuous aggregate exists and is materialized-only; no refresh policy was listed. Current inspected runtime sources use `production_hourly`, so this view was retained pending verification of outside consumers.
- Three placement constraints remain `NOT VALID`: `fk_line_plant_company_pms`, `fk_machine_line_placement_pms`, `fk_machine_plant_company_pms`. New writes are constrained, but legacy rows are not certified. Reconcile legacy placement and validate them before release.
- No public-table RLS policies are enabled. The current tenant boundary is application authorization plus composite ownership constraints. The socket permission gap found in that boundary was fixed. Least-privilege database accounts remain essential.
- **The configured connection used a superuser role and TLS was off.** Replace runtime credentials with a verified least-privilege account, separate migration authority, restrict network access, and enable certificate-verified TLS before deployment. Account/transport changes were not applied blindly to an ambiguously classified remote database.
- The migration catalogue begins by altering an existing legacy schema; it is not a complete empty-database installer. Check in a vetted baseline/schema bootstrap and perform a full restore/upgrade rehearsal. Do not label an empty-database migration attempt as verified.

Actual SQL tests used disposable local PostgreSQL **18.3**, with TimescaleDB **2.30.2** for ingestion/capacity. These do not certify migrations/restore/compression against the configured server's older versions. No redundant indexes were dropped based only on catalog resemblance: active query plans and outside consumers must justify removal.

## Executed verification

| Check | Final executed result |
| --- | --- |
| Backend Jest | 119 suites, **2,280 passed** |
| Collector Jest, including temporary real MQTT broker | 22 suites, **399 passed** |
| Web unit | 46 files, **350 passed** |
| Mobile Node tests | **57 passed** |
| Mobile TypeScript | Passed |
| Electron security/unit checks | **4 passed** |
| Browser assistant/dashboard access/admin/settings/PMS jobs | **68 passed** |
| Browser Program Transfer | **12 passed** |
| Browser slow first render and 10,000-machine pagination/recovery | **3 passed** |
| Angular production build | Passed; budget warnings below |
| Expo SDK 57 web export | Passed; not a native device release build |
| PostgreSQL PMS integrity | Passed: migration replay/rollback, snapshots, start/stop, concurrent limits, assignments, ownership and maintenance/ticket consistency |
| PostgreSQL authorization | Passed: committed role/company/user revocation, stale socket handshakes, rollback, forged scope, Redis outage and BIGINT revision handling |
| PostgreSQL plant isolation | Passed: actual JWT/HTTP/socket paths, nine analytics modules, detail/history, XLSX/CSV, shift metadata, concurrent quality and cache separation |
| PostgreSQL collector durability | Passed: raw/hourly/alarm/meter/outbox once through database/Redis outages and lost COMMIT replies, grants and gap integrity |
| PostgreSQL local/legacy media | Passed: ownership, immutability, migration replay, concurrent imports and partial-commit cleanup |
| Alarm notification database fixture | Passed, **137 assertions** |

The unit/mobile/desktop/core-browser results above total **3,173 passing tests**, excluding separate SQL fixture assertions. The final combined Program Transfer/slow-dashboard/pagination run passed all 15 scenarios.

Initial browser runs exposed both real refresh-timer behavior and invalid test setup: HTTP routes did not close WebSockets, and hardcoded fixture origins refused a different local test server. Initial SQL fixtures also omitted newer schema/permission requirements. Those failures were investigated; successful reruns use the corrected fixtures. Expected negative-case errors in logs are not silently converted to success.

Negative coverage includes invalid/cross-tenant identifiers, roles without machine access, revoked sessions, expired/stale grants, concurrent PMS/quality mutations, malformed counters, failed/partial media operations, duplicate reports, delayed replies, stalled transfers, disconnect/retry, durable replay after commit ambiguity, health dependency hangs and shutdown hangs. This is not exhaustive validation of every browser route, native device, firmware or combination of simultaneous exports/PMS/transfers.

## Measured performance

Host: Apple M3, eight logical CPUs, 8 GB RAM, macOS arm64, Node **24.22.1**. See [host metadata](audit/2026-10-24/host.json).

### Comparable local measurements

| Fixture | Before | After | Interpretation |
| --- | --- | --- | --- |
| 10,000 admissions / 1,000 machine states, Redis down, DB waiting, per-message durable sync | 31,828 ms; 314 messages/s; admission p95 4.049 ms | 30,963 ms; 323 messages/s; p95 3.970 ms | About 2.9% throughput difference in one sample; filesystem variance can explain small changes. No material ingestion speedup is established. |
| Same admission fixture event-loop p99 / RSS growth | 11.28 ms / 24.1 MB | 11.24 ms / 29.4 MB | RSS did not improve in this sample. Both accepted 10,000 without refusal. Pending journal rows are expected because this fixture deliberately does not flush to DB. |
| Twenty concurrent cost-10 fixture password hashes | bcryptjs 3.0.3: 1,097 ms | Native bcrypt 6: 297 ms | Same-host implementation comparison, about 73% less elapsed time; bidirectional old/new hash verification passed. Not an HTTP login SLA. |

[Before admission](audit/2026-10-24/admission-before.json), [after admission](audit/2026-10-24/admission-after.json), [hashing comparison](audit/2026-10-24/password-hash.json).

### Machine/viewer capacity matrix

Fresh local PostgreSQL/TimescaleDB with **1,000,000 historical rows**, actual loopback MQTT/QoS1, journal/admission/flusher, actual SQL/JWT/access middleware, and 100 authenticated sockets across three companies. Each tier publishes one message/machine/second for five seconds; 100 concurrent HTTP viewers each request a 25-machine fleet page every second. Redis cache/fanout is represented in memory. The fixture uses a constructed telemetry schema, not a full restored deployment schema.

| Machines | Messages | HTTP p95 | Publish-to-commit p95 | Offer + drain | Backlog at offer end | Effective durable throughput |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 250 | 167.27 ms | 257.85 ms | 5.039 s | 0 | 49.6/s |
| 100 | 500 | 48.60 ms | 297.55 ms | 5.031 s | 0 | 99.4/s |
| 500 | 2,500 | 49.23 ms | 3,398.64 ms | 7.822 s | 808 | 319.6/s |
| 1,000 | 5,000 | 60.40 ms | 9,946.49 ms | 14.651 s | 3,349 | 341.3/s |

All **8,250** published rows reached durable storage; the final raw-row count was exactly **1,008,250**, journal pending zero, admission failures zero, foreign rows/events zero and HTTP errors zero across **2,000 requests**. Positive socket delivery is asserted: 250/500/500/500 events matched the 100 single-machine subscriptions at the four tiers. The fixture's Node RSS peaked at 288.9 MB; that process also includes test publishers/viewers and excludes the database/broker processes. JSON reports Node CPU, event-loop delay, API response bytes, pool waiters, aggregate query timings and separate fleet-handler timings. These are not whole-host CPU/network or browser rendering measurements.

**The collector did not sustain 500 or 1,000 messages/second on this local durability path.** Eventual lossless drain of a short burst does not establish continuous capacity. The serialized admission/per-message durable-sync path saturates around 320–340/s here. Do not remove fsync, acknowledge before durability or bypass tenant checks to improve a score. Measure deployment storage first; if partitioning is needed, design nonoverlapping machine ownership and independent journal/checkpoint identities, then repeat crash/replay/ordering and long-duration tests. No unverified automatic sharding was introduced.

Provisional release targets for the actual deployment: dashboard API p95 below 500 ms under 100 viewers, publish-to-commit p95 below one second at the agreed sustained machine rate, no unbounded backlog, zero accepted-data loss and zero scope leaks. The local five-second 50/100 tiers meet those latency/burst targets; 500/1,000 fail ingestion latency/capacity. A 24-hour soak, backlog replay and mixed exports/PMS/transfers on deployment hardware are still required. No cloud capacity or paid-server sizing claim follows from this laptop test.

### Frontend build

Angular production initial output is **548.42 kB raw / 127.95 kB estimated transfer**. Charts and page modules remain lazy loaded. The build passes its 1 MB error threshold but exceeds the 500 kB initial warning by 48.42 kB. Maintenance-dashboard and assistant-chat styles also exceed 4 kB warning thresholds while staying below 8 kB errors. These warnings were retained as visible work, not hidden by increasing budgets. Expo web output is about 1.2 MB; it does not measure native launch/battery performance or slow-network LCP. No before/after bundle improvement is claimed.

## Dependency verification

Current saved lockfiles: Backend **0**, web **0**, collector **0** npm advisory entries; mobile **5 high entries**, zero critical. Counts describe affected package chains, not five independent mobile exploits. Compatible updates include body-parser 2.4.0, multer 2.5.0, nodemailer 10.2.1, collector ip-address and Expo-compatible patches. Web scopes an undici 7.30.1 override to Angular build tooling; it keeps Angular 21. The backend lockfile was explicitly reconciled so clean installations receive the tested security versions.

Mobile's remaining chains originate in node-forge 1.4.0 and Zod 3.25.76 through Expo CLI/certificate tooling. The [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) lists no patched release; the [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) lists 4.6.6, a major change from Expo's installed API dependency. A forced Zod-major override or npm's suggested Expo 44 downgrade was not applied. Recheck an upstream compatible Expo/tooling fix before release; do not expose development servers publicly or treat a nonzero audit as waived. Native/bundled reachability is not independently certified by this audit.

Removed direct packages: backend bcryptjs; mobile expo-device and expo-notifications. Historical guides may contain previous dependency counts and are dated records; this report and its saved audit JSON are the current evidence.

## Program-transfer acceptance limits

The folder adapter confirms the bytes in a configured folder; it does not establish a controller's active program or safe-to-overwrite machine state. Backup now chooses the newest regular file for this adapter. Actual FANUC/FOCAS, Mitsubishi, FTP/DNC support and acknowledgement semantics must be selected and tested with the installed gateway/controller. Large files use authenticated HTTP, not telemetry MQTT.

One gateway process may own a machine at a time. Distinct `MACHINE_DIRS` can partition ownership, but the API has no distributed transfer lease for overlapping gateway processes. Do not deploy competing writers to the same CNC. Safety versions need a disk budget/operator retention policy; none are automatically deleted. Network-share locking, fsync/rename behavior, ACL ownership and controller read-back need factory acceptance.

## Release checklist and remaining work

- [x] Implement and locally verify the concrete code defects above, without changing required workflows.
- [x] Preserve tenant/plant checks, durable admission, atomic commit/checkpoint behavior, signed company AI history and opt-in access.
- [x] Run current dependency audits, web build, mobile type check/export, unit/browser and disposable SQL/MQTT fixtures.
- [ ] Replace the configured superuser runtime credentials and enable verified TLS/private networking; recheck grants for API, collector and migrations separately.
- [ ] Reconcile and validate three legacy placement constraints; agree retention and verify backup/restore including program files and pending journals.
- [ ] Provide a vetted empty-database baseline and rehearse full upgrade/rollback/restore on PostgreSQL 14.21/Timescale 2.19.3, or the exact chosen deployment versions.
- [ ] Meet the chosen sustained machine-rate/latency target on deployment hardware. Current evidence does not support 500/1,000 Hz on a single local collector.
- [ ] Resolve or formally assess remaining Expo tooling advisories using compatible upstream fixes; perform signed Android/iOS builds and physical-device foreground/background, SecureStore, theme and connectivity acceptance.
- [ ] Validate real CNC transfer, active-program backup, permissions, machine-state interlocks, restart and interrupted-write recovery. Enforce a single owner per machine operationally until distributed leases are implemented/tested.
- [ ] Run mixed PMS/export/transfer load, 24-hour soak, real Redis/broker restart and gateway recovery, deployment-origin/CORS/TLS, monitoring/log rotation and restore drills. The load fixture's in-memory Redis and local network are insufficient for these claims.
- [ ] Address bundle/style warning budgets based on measured slow-device/network performance. Execute hosted CI and final release packaging; no deployment or publication was performed here.

## Reproduction

Keep all four repositories adjacent and install their lockfiles. Use each repository's Node selector; mobile requires Node >=22.13 and selects 24. The executed audit used Node 24.22.1. Unit tests isolate configured services; SQL/capacity tools create and remove their own private local databases and never load the application `.env`.

```sh
# Backend
npm test -- --runInBand
node tools/architecture/verify-pms-integrity.cjs
node tools/architecture/verify-auth-revocation.cjs
node tools/architecture/verify-plant-read-isolation.cjs
node tools/architecture/verify-local-media.cjs
node tools/architecture/verify-legacy-images.cjs
node tools/architecture/verify-alarm-notifications.cjs
node tools/loadtest/platform-local.cjs 5 1000000

# pms-backend
npm test -- --runInBand
node tools/verify-ingestion.mjs
node tools/benchmark-admission.mjs 10000 1000

# FrontendIOT
npm run test:ci
npm run test:desktop
npm run build
npm run e2e -- e2e/jobs.spec.ts e2e/assistant.spec.ts e2e/dashboard-access.spec.ts e2e/super-admin-flow.spec.ts e2e/header-settings.spec.ts --workers=2
npm run e2e -- e2e/program-transfer.spec.ts e2e/fleet-pagination.spec.ts e2e/dashboard-first-paint.spec.ts --workers=2

# MobileApp
npm run typecheck
npm test
npx expo export --platform web
```

The capacity tool currently expects local Homebrew PostgreSQL/TimescaleDB and Mosquitto binaries, and both backend/collector dependency trees. It intentionally accepts no external database URL. The password comparison tool accepts an extracted bcryptjs 3.0.3 CommonJS entry as its argument; do not reinstall that retired package into the application. Run `npm audit --json` separately in every repository; advisories can change after this report.
