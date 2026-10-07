# CNC platform implementation — 7 October 2026

This change implements the first application upgrades from the architecture review across `Backend`, `pms-backend`, `FrontendIOT`, and `MobileApp`. It preserves the current PostgreSQL/TimescaleDB, Redis, MQTT, Angular and Expo stack and adds no runtime dependencies or paid services.

It is a tested local implementation, not a production deployment or a claim of unlimited capacity. The database-enforcement, ingestion-durability and distributed-operation work below remains part of the larger blueprint.

## What changed

| Area | Implemented behavior | Cost / reliability benefit |
|---|---|---|
| Fleet API | Opt-in bounded pages, status filtering, literal serial-number search, whole-company counts | Heavy production/operator/job calculations and response payloads cover only the requested machines |
| Tenant scope | Fleet queries use the authenticated company; socket subscriptions validate active machine ownership in a batch | A client cannot subscribe to another company's machine by supplying its ID |
| Live delivery | At most 100 machine IDs per subscription; 10 subscription requests/second/socket; company feed retained for older clients | Current web/mobile screens receive their selected machines instead of every machine in the company |
| Collector retries | Each database transaction locks and re-reads the durable checkpoint before additive writes | A successful COMMIT whose reply is lost can be retried without counting that journal batch twice |
| Web | Six-machine server pages, whole-fleet status totals, reconnect reconciliation, resilient foreground polling, independent listener cleanup | Bounded work and DOM size; refresh recovers after transient failures |
| Web appearance | Original Live Dashboard appearance restored at the user's request | Architecture and performance improvements remain in place |
| Mobile | 25-machine server pages, debounced search, virtualized list, 500 ms live-update batching, focus/background gating | Bounded network and rendering work on smaller devices |
| Mobile assets | Direct imports of the one icon family used by the application | Removes unused font families from exported application assets |
| Session isolation | HTTP responses/refreshes tied to the active session, shared refresh calls, socket teardown on expiry/logout, serialized mobile credential writes | A previous account's delayed work cannot restore its credentials or data into a later session |

Web fleet updates keep only the latest queued gauge/status payload per visible machine before the next animation frame. Mobile flushes such display changes at most twice per second. Neither is a durable event log. Summary counts refresh from HTTP, so a single live card can change before the whole-fleet summary catches up.

The Live Dashboard visual redesign, added offline filter and image fallback were reverted at the user's request. Server pagination, bounded socket subscriptions, session protections and the mobile changes remain included. The backend still supports `status=offline` for clients that use it.

The mobile summary ring now shows the percentage of the entire fleet running. It no longer presents the average utilization of just the current page as a fleet-wide utilization figure.

## Fleet HTTP contract

```http
GET /api/dashboard?paged=1&page=1&per_page=25&status=all&search=CNC
Authorization: Bearer <access token>
```

- `paged=1` explicitly opts in. Omitting `paged` retains the existing legacy response behavior.
- `page`: integer 1–100000; default 1.
- `per_page`: integer 1–100; default 25.
- `status`: `all`, `running`, `idle`, `alarm`, `offline`.
- `search`: literal case-insensitive serial-number substring, at most 100 characters. `%` is not a wildcard.
- Tenant identity comes from the authenticated user, never from a query-string company ID.
- Existing response fields remain. `pagination` adds `page`, `per_page`, filtered `total`, and `total_pages` (minimum 1).
- `summary` contains whole-company `total`, `running`, `idle`, `offline`, and `alarm`. An alarm can overlap a running/idle/offline state; do not sum all four as disjoint categories.
- Machine rows include `received_at` in epoch seconds for freshness checks.
- An out-of-range page returns an empty list and valid counts. Clients return to the last valid page.
- Existing no-active-shift behavior is preserved: an empty dashboard is returned.

The new query obtains status and counts in one database snapshot. It uses the existing tenant/machine/time access pattern for the latest reading within an hour and the existing 60-second offline threshold. It still inspects the company's fleet for counts/filtering; it is not constant-time as the fleet grows. A durable `machine_latest` table or measured shared-summary cache is the next optimization if that lookup becomes expensive.

## Socket contract

```js
socket.emit('subscribeMachines', [12, 18, 24], acknowledgement => {
  // { ok: true } or { ok: false, code: 'FORBIDDEN' | ... }
});
```

On successful authorization, the server leaves the legacy company feed and joins only the requested machine rooms. `[]` removes machine subscriptions. Invalid/foreign IDs do not grant access. The last valid asynchronous scope request wins; stale query results cannot overwrite a newer request. Machine room names are built on the server using the authenticated company.

Reconnects reapply the client scope and trigger an HTTP snapshot. HTTP remains available when WebSockets are blocked. Current clients do not implement a durable sequence-gap/replay protocol; periodic snapshots provide reconciliation. Timestamps reject older visible updates but are not a substitute for durable event identities.

The room transition code targets the existing in-process Socket.IO adapter. It does not enable a distributed adapter, shared revocation, or multi-instance event ownership. Do not infer cluster readiness from these changes.

## Validation

All automated checks use local fixtures/mocks or an explicitly disposable local database. No production API, MQTT broker, Redis instance or database was contacted.

| Check | Result |
|---|---|
| Backend Jest | 69 suites, 1,412 tests passed |
| Collector Jest | 15 suites, 294 tests passed |
| Angular Vitest | 23 files, 205 tests passed |
| Mobile session/socket regression tests | 11 passed |
| Mobile TypeScript | Passed |
| Expo production export | Android, iOS and web bundles passed |
| Real PostgreSQL fixture | Tenant filtering, bounds, counts, literal search, empty pages and dashboard integration passed |
| Real PostgreSQL retry fixture | Lost COMMIT response and concurrent checkpoint writers produced one write per journal record |
| Playwright | Mocked 10,000-machine fleet: six rendered cards, server totals/filter/page requests and recovery after a failed request passed |
| Web production build | Passed; initial assets about 500.52 kB raw / 122.40 kB estimated transfer, excluding later lazy chunks and media |

The web build reports two budget warnings: initial assets exceed the 500 kB warning by about 519 bytes; the existing maintenance-dashboard stylesheet remains 6.94 kB against its 4 kB warning budget. No budgets were increased to hide them.

The icon-import optimization reduced Android Hermes bytecode from 2,947,257 to 2,612,331 bytes and iOS bytecode from 2,943,316 to 2,607,974 bytes (about 11%). The combined Android/iOS/web export directory fell from 15,733,243 to 7,256,909 bytes, including assets shared/duplicated by the export formats. These are export sizes, not installed APK/IPA sizes or measured startup times. The final export is at `/tmp/cnc-mobile-export-lean-20261007`.

After restoring the original Live Dashboard appearance, the existing Playwright fleet pagination/recovery check passed again, including its phone-width overflow check. The fixture screenshots in `test-results/fleet-desktop.png` and `test-results/fleet-mobile.png` at the workspace root were regenerated for the restored layout. The other validation results above are retained as test history from the architecture implementation.

The PostgreSQL fixture used a temporary local PostgreSQL 18 database with ordinary tables. It proves the SQL/transaction behavior exercised, not Timescale compression compatibility, production throughput, or performance on long telemetry history. Its schema was removed and its temporary server stopped. The browser's 10,000-machine total is mocked; it is a frontend bound/recovery test, not a 10,000-machine ingestion load test.

Reproduce from each project with Node 22.13+ (validation used Node 22.23.2):

```sh
# Backend
npm test -- --runInBand
# pms-backend
npm test -- --runInBand
# FrontendIOT
npm run test:ci
npm run build -- --configuration production
npx playwright test --config playwright.architecture.config.ts
# MobileApp
npm run test:realtime
npm run typecheck
npx expo export --platform all --max-workers 2 --output-dir /tmp/cnc-mobile-export
```

For the additional PostgreSQL verification, create a disposable local database named `cnc_architecture_test` and set `ARCHITECTURE_TEST_URL` explicitly before running `node Backend/tools/architecture/verify.cjs` from the workspace root. The tool refuses remote hosts and other database names, never loads application environment files, and creates/drops its own fixture schema.

## Rollout

1. Deploy the Backend changes first. Check the existing latest-telemetry index and migration `035_ingest_journal.sql` are already present, using the normal migration process. This change introduces no schema migration.
2. Roll out the collector with its existing persistent journal directory and stable collector ID. Keep one active owner of each machine partition; the retry fix does not authorize multiple independent collectors ingesting the same machines.
3. Deploy the web build and then the mobile update. Older clients retain the legacy API/company feed. New clients require the new backend to obtain bounded pages and complete summary fields.
4. In staging with production-matching PostgreSQL/Timescale versions, measure query latency, pool wait, journal age/bytes, MQTT lag, socket fan-out and device frame time at realistic reporting rates. Increase capacity only from measured bottlenecks.

No `.env` file, infrastructure configuration, database policy, production data or release signing credential was changed. Existing user edits in `FrontendIOT/README.md`, `FrontendIOT/src/environments/environment.ts`, its isolated Playwright configuration, and `MobileApp/app.json` were preserved.

## Remaining architecture work before claiming the full target design

- **Durable MQTT acceptance:** current MQTT acknowledgement still precedes a confirmed durable journal boundary; journal-full backpressure and alarms/meters outside that path remain to be addressed. This patch fixes database replay, not end-to-end loss guarantees.
- **Database-enforced tenancy:** RLS, tenant backfill, composite ownership constraints, least-privilege runtime roles and authentication bootstrap require a coordinated migration against the actual deployed schema/extension versions.
- **Retention and aggregates:** agree retention requirements, verify rollup correctness/late arrivals, then apply bounded raw-history retention. No data-deleting policy was applied automatically.
- **Horizontal scaling:** shared socket revocation/adapter ordering, distributed report limits, shared uploads, collector partition leases/fencing and connection budgets remain necessary before adding replicas safely.
- **Mobile delivery:** push-token registration/delivery is still unfinished. Native signed iOS/Android builds and real-device testing remain required; JavaScript bundling and TypeScript checks do not establish native compatibility on every device.
- **Capacity/cost:** fleet size, reporting interval, concurrent users, history retention and hosting budget are still unspecified. No monthly cost, unlimited-machine promise, certification, uptime SLA or industrial safety compliance is implied.

The existing SDK 57 baseline targets Android 7+ and iOS 16.4+; it cannot support every historic Android/iPhone model. Keep one shared Expo application and validate release builds on representative low-memory Android devices, supported iPhones and tablets. See the [versioned Expo SDK documentation](https://docs.expo.dev/versions/v57.0.0/).
