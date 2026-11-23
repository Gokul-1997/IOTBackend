# Energy database audit and rebuild

## Result and deployment status

The repository contains an additive replacement for energy accounting, shared
readers for dashboards/reports/machine details/meter panels, bounded collector
batch writes, migration/rollback scripts, and a guarded historical rebuild.
The replacement is disabled until `ENERGY_V2_ENABLED=true` **and** the company's
`energy_pipeline_state.ready=true`. Installing the schema does not switch data
sources. No raw retention or historical deletion is enabled by these migrations.

The installed PostgreSQL 14.21 / TimescaleDB 2.19.3 combination was inspected.
The new schema and shared readers passed an isolated, rolled-back integration
test on TimescaleDB 2.19.3. This verifies compatibility, not live deployment or
production load capacity. Use the operational checks below before cutover.

## Problems found

1. Several energy pages independently calculated cumulative differences from
   raw history. Repeated counter drops/recoveries could be treated differently,
   and a minimum five-minute plausibility window accepted large short spikes.
2. Latest electrical fields required a month scan; independent sparse fields
   need their own real observation time. Missing values and future samples
   must not become fresh measurements or manufactured zeros.
3. Delayed/stale meter packets were audited but could miss the typed energy
   source. Valid delayed measurements now enter that source without advancing
   CNC status, runtime, production counts, alarms or live high-water state.
4. The collector issued individual meter inserts. New typed batches preserve
   journal order, field precedence and tenant guards with at most 1,000 rows
   and 57 bind parameters per statement. Poisoned rows remain quarantinable.
5. A standalone gap used a reason outside the database CHECK constraint,
   potentially quarantining a valid reading. It now uses `observations_missing`.
6. There were no energy continuous aggregates, no typed-meter compression
   policy, and no explicit meter tenant/device/time index. Source owner/company
   constraints were incomplete. New writes are constrained; existing suspect
   ownership must be reviewed before validating old rows.
7. The existing `production_hourly_mv` is a stale, unused production aggregate,
   with unsuitable sample-count/MAX(counter) accounting. It is preserved and
   is not used as an energy or validated production source.
8. A historical correction outside a refresh policy's window could leave a
   materialized total stale. A durable refresh queue now keeps affected buckets
   on validated facts until the closed buckets are refreshed successfully.
9. Shift deletion independently erased historical summary rows before deleting
   the shift. A later FK failure could leave that history lost. Deletion is now
   atomic and refuses shifts with recorded history; deactivation remains available.

The static DB inventory covers the repository's query call sites, relations,
indexes, FKs, triggers, functions, policies and aggregates. The measured/deep
correctness review focuses on energy and its cross-page consumers. It is not
a claim that every possible defect in every business API has been eliminated.

## Measured baseline

Read-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the installed database,
company 4 / machine 19, measured approximately:

| Query | PostgreSQL execution time |
|---|---:|
| Latest independent meter fields, 30-day search | 234 ms |
| Old canonical raw-energy calculation, one day | 232 ms |
| Old canonical raw-energy calculation, seven days | 1,239 ms |

These are individual SQL measurements, not whole-fleet response times or an SLA.
The audited footprint was about 3.41 GB of raw telemetry, 114 MB of typed meter
readings, daily telemetry chunks and weekly meter chunks. Telemetry compression
was already healthy. Most fleet data was in one company; no extrapolation to
thousands of machines is justified from this sample alone.

A disposable local PostgreSQL equivalence test processed 1,408 observations
into identical 1,054 rows: 1,408 sequential statements versus 31 bounded batch
statements, approximately 585 ms versus 47 ms on that local test. Tenant
collisions intentionally split batches. This is a local comparison, not cloud
capacity evidence. Re-measure cold/warm APIs and SQL after real backfill and
materialization; do not advertise unmeasured production speedups.

## Schema and storage

Authoritative DDL is in migrations `064_energy_interval_pipeline.sql` and
`065_energy_continuous_aggregates.sql`.

| Object | Purpose and key |
|---|---|
| `energy_meter_readings` | Original typed sparse observations; PK `(machine_id,read_at)`, tenant/device/time index, guarded upsert |
| `energy_meter_latest` | One row/company/device: actual channel values plus independent epoch-ms event timestamps |
| `energy_counter_intervals` | Derived per-register differences and validation state; PK `(company_id,machine_id,register,observed_at)` |
| `energy_counter_state` | Restart/replay checkpoints; never an alternative raw source |
| `energy_meter_rules` | Effective-dated limits, resolution, maximum allocatable gap and optional counter modulus |
| `energy_counter_events` | Explicit reset/replacement events with optional verified baseline and required explanatory note |
| `energy_reconcile_queue` | Durable earliest replay point, including a separate crash-safe claim |
| `energy_refresh_queue` | Durable changed range; readers bypass affected materialized buckets until refresh succeeds |
| `energy_pipeline_state` | Per-company readiness and verified backfill coverage |
| `energy_backfill_windows` | Committed source scan certificates; gaps prevent cutover |

All event/storage timestamps use `timestamptz`. Engineering measurements and
derived quantities use floating-point precision; money settings retain the
existing numeric schema. Do not use binary floating-point quantities as a
financial billing ledger. The displayed cost is an estimate using current
tariffs, effective per-machine overrides and one consistent currency.

With TimescaleDB, typed meter rows and interval facts are hypertables with
seven-day chunks. Meter compression starts after 30 days, segmented by company
and machine, ordered by `read_at DESC`. Interval compression starts after 120
days, segmented by company/machine/register, ordered by `observed_at DESC`.
Small metadata, queue and existing production summary tables stay ordinary
PostgreSQL tables; converting every timestamped table is not useful.

Continuous aggregates use the Asia/Kolkata calendar, explicitly enable real-time
aggregation and start `WITH NO DATA`:

| View | Bucket | Refresh window / schedule | Compression |
|---|---|---|---|
| `energy_counter_hourly` | 1 hour | last 7 days, exclude last minute / 5 minutes | after 30 days |
| `energy_counter_daily` | 1 day | last 7 days, exclude last hour / 5 minutes | after 30 days |
| `energy_counter_monthly` | 1 month | last 3 months, exclude last hour / 5 minutes | after 120 days |
| `energy_electrical_1m` | 1 minute | last 7 days, exclude last minute / 1 minute | after 30 days |

Counter CAGGs operate on validated scalar interval facts, not window functions
over raw counters. Electrical aggregates store separate sum/count/min/max for
each field, so sparse fields and weighted averages remain correct. Complete
calendar buckets use summaries; partial edges use bounded typed/fact rows.

## Reading-to-report flow

1. The existing machine topic accepts a full packet or any valid supplied
   energy field. Fixed-unit keys retain their specified dimension. Explicit
   W/kW/MW and Wh/kWh/MWh values are normalized; negative instantaneous power
   remains signed and cumulative energy must be nonnegative. Lowercase `mW`
   and `mWh` are rejected rather than misread as mega-units.
2. The durable ingestion journal commits before acknowledgement. Bounded typed
   inserts merge duplicates using `ON CONFLICT`. Standalone per-field claims
   retain priority over aliases from a full CNC message at the same device time.
   `read_at` is the original event time; `received_at` is DB receipt time. The
   late audit also preserves the original admission receipt timestamp.
3. A source trigger updates each latest field only from its actual event time
   and enqueues replay. A voltage-only observation does not refresh a stale
   current or counter field. Tenant ownership is enforced on new writes.
4. A single bounded worker replays each device forward, keeping a high-water
   baseline through regressions/spikes. A late correction can affect more than
   its two neighbours, so replay continues through later observations. Claims
   and exact source cursors survive crashes; corrections and deletions remove
   obsolete derived facts without deleting original measurements.
5. A decrease is unknown until a declared reset/replacement or configured,
   plausible rollover. A genuine unchanged pair gives zero. An unexplained
   `100 -> 90 -> 100 -> 101` contributes one, not eleven. No reset is guessed.
6. The known increase across a long gap remains an explicitly incomplete
   subtotal. A long gap sets `allocated=false` and is never distributed across
   missing hours. Normal measured pairs, including hour/shift boundaries, follow
   the same measurement-end convention on every page. No fractional split is
   invented, and healthy boundary pairs are not labelled as missing readings.
7. Aggregates, facts and queue state are read in a single query snapshot.
   Dirty historical buckets bypass stale materializations. Automatic top-level
   refreshes repair closed buckets; failed/compressed historical refreshes stay
   queued and readers continue to use validated facts for those buckets.
8. Reports, energy dashboards, factory summaries, meter details and machine
   details use the same shared store. Unknown is `null`/`--`; a measured zero
   remains zero. Coverage includes gaps, pending replay, missing elapsed time,
   absent devices and unallocated intervals. Incomplete consumption does not
   produce a falsely complete cost or efficiency claim. Energy without a
   matching production row is explicitly reported as coverage metadata.

Timescale `time_bucket_gapfill` may produce a display series with NULL gaps.
LOCF/interpolation may be used for explicitly labelled visual estimates, never
to create measured consumption, report totals or billable kWh. Current charts
preserve unknown gaps and do not manufacture energy with either function.

## Safe migration and backfill

Use deployment-managed secrets for `ENERGY_DATABASE_URL`; do not put a password
in command arguments, Git, logs or this document. The operations scripts require
that explicit connection and do not silently load the production `.env`.

1. Take and verify a database backup and enough free-space headroom. Run the
   read-only auditor. Verify migration 063/checksum and the owner audit.
   Preview then install the additive migrations 064–066:

   ```sh
   node scripts/apply-energy-migrations.js
   node scripts/apply-energy-migrations.js --apply
   ```

   Migration 066 adds the nullable THD channels for the nested energy payload;
   install it before deploying the updated API and collector. On older
   TimescaleDB versions, a column-level GRANT is incorrectly forwarded to the
   compressed parent even though ADD COLUMN updates only compressed chunks.
   If the earlier 066 failed with `column "thd_v1n" of relation
   "_compressed_hypertable_..." does not exist`, pull the corrected code and
   rerun the migration. Its schema changes and ledger entry are atomic, so a
   failed attempt needs no manual ledger edit.

   The corrected 066 tries the normal grant first. Only that legacy failure
   uses transaction-local `timescaledb.restoring` around the grant, restoring
   its previous value immediately afterward. It does not decompress history
   or grant table-level UPDATE. The fallback requires a database superuser
   or permission to set that parameter; otherwise the migration rolls back
   with administrator guidance. Successful installations of the exact
   original 066 remain accepted by the runner without rewriting their ledger
   or executing the migration again; other checksum drift is still rejected.

2. Deploy the collector with the lossless typed-field/late-reading/batch fixes.
   Deploy API/web/mobile code with `ENERGY_V2_ENABLED=false`. Check collector
   journal/quarantine metrics, constraints and DB locks; ingestion remains live.
3. For **each company**, run preflight and choose `--from` before its oldest
   raw receipt and meter event, and `--to` at a recent fixed completed instant.
   The examples show syntax; choose the real audited dates and company ID.

   ```sh
   node scripts/energy-rebuild.js --company-id 4 --stage preflight
   node scripts/energy-rebuild.js --company-id 4 --stage source --from 2026-01-01T00:00:00Z --to 2026-11-02T00:00:00Z --step-minutes 15 --apply
   node scripts/energy-rebuild.js --company-id 4 --stage seed --apply
   node scripts/energy-rebuild.js --company-id 4 --stage drain --apply
   node scripts/energy-rebuild.js --company-id 4 --stage refresh --from 2026-01-01T00:00:00Z --to 2026-11-02T00:00:00Z --apply
   node scripts/energy-rebuild.js --company-id 4 --stage verify --from 2026-01-01T00:00:00Z --to 2026-11-02T00:00:00Z --apply
   ```

   Source scans are bounded by receipt-time predicates for chunk pruning,
   retain original event time, fill only absent typed fields and certify each
   committed window atomically. Re-running a window is safe. Reduce the step
   size if collector lag or DB latency rises. Latest seeding and reconciliation
   use all retained typed history, not only the visible report date.
4. Refresh runs as top-level CALLs, never inside a migration/DO/transaction.
   Only closed buckets are materialized: advancing a monthly watermark into
   the future would hide subsequently arriving current-month observations.
   Old compressed materializations require capacity review and explicit
   `--decompress`; policy scheduling is restored afterwards. Raw data remains.
5. Verification checks source-to-fact count/value parity and every complete
   device/register/shift bucket, including electrical sums/counts/extrema.
   Cutover also checks full retained history, certified source-window coverage,
   no pending reconciliation/refresh work and lossless capture of the recent
   raw tail. It refuses gaps rather than guessing missing history.
6. Run the same dated command with `--stage enable --apply`. Then set
   `ENERGY_V2_ENABLED=true` on the API and worker and restart instances. Energy
   cache keys include the pipeline version; readiness memory caches also reset.
   Recheck the same machine/day/overnight shift across all pages,
   source data, CSV/Excel, and the assistant. Keep the saved verification output.

The scripts never delete or rewrite original telemetry/production history.
Migration FK constraints for old rows are `NOT VALID` until ownership review;
new writes are still checked. Validate explicitly after resolving audited
ownership exceptions, without changing them to an invented company.

## Rollback and retention

For an application rollback, set the feature flag false, restart instances,
and leave additive tables in place. To remove derived schema, first export
rules/events/facts and verify restoration. Apply `rollback/065..._down.sql`
before `rollback/064..._down.sql`. The latter refuses removal of nonempty
derived history without the explicit session acknowledgement
`iot.energy_derived_backup_verified=true`. These rollback scripts remove only
their own migration-ledger markers. Keep the deployment/ledger snapshot for
recovery; do not silently rewrite applied migration checksums.
Original telemetry, typed meter rows and production summaries are preserved.

No destructive retention policy is installed automatically. The separate
`scripts/energy-retention-opt-in.sql` proposes 365-day meter / 730-day interval
retention and refuses to run without verified archive recovery and consumer
history horizons. It does not alter raw CNC telemetry retention. CAGG refresh
windows must stay inside retained source history; restore archived data before
repairing a correction beyond retention. Compression is lossless and can stay
enabled during application rollback.

## Repeatable verification and operations

```sh
npm test -- --runInBand
node scripts/verify-energy-database.js
node scripts/verify-energy-thd-migration.js
```

The second command requires `ENERGY_TEST_DATABASE_URL`; it creates an isolated
schema inside one transaction and always rolls back. It covers migrations,
sparse timestamps, high-water/paged replay, zero/NULL, tenant separation,
shared-reader parity and source deletion repair. It supports plain PostgreSQL
for local tests and installed TimescaleDB for actual compatibility checks.
The collector has `tools/verify-ingestion.mjs` and `tools/verify-meter-batch.mjs`.
The THD verifier also requires an explicit `ENERGY_TEST_DATABASE_URL` pointing
to a disposable administrator test database. It checks compressed history and
collector permissions, and emulates the legacy GRANT failure on newer
TimescaleDB to exercise fallback, setting restoration and permission-denied
rollback. Its temporary schema, roles and event trigger always roll back.

After materialization, re-run the auditor and `EXPLAIN ANALYZE` on representative
one-day/seven-day/monthly queries. Check actual chunk pruning, indexes, materialized
row reads, pending/failed jobs, worker oldest dirty time, collector backlog,
quarantine count, pool wait, query p95 and API p95 under representative traffic.
Energy query concurrency is capped at four per API process by default
(`DB_ENERGY_QUERY_MAX`), with a bounded waiting queue and a busy response rather
than unbounded connection pressure. Account for all API replicas when sizing
the database pool; this is not a guarantee that other query types reserve a
particular number of connections. The existing read-only assistant pool and
authorization/plant scope still apply.
`pg_stat_statements` was absent; enabling it requires server configuration and
possibly restart, so the migration does not pretend it is installed.

For a private post-cutover comparison, use the auditor with `--explain --v2
--company 4 --machine 19 --out /absolute/private/new-audit.json` and an explicit
`SCHEMA_AUDIT_URL`. It includes old raw plans and new projection/hourly read
plans. Confirm nonempty materialized history and inspect the shared reader's
dirty-bucket fallback separately when investigating delayed corrections.

## Compatibility references

- [Continuous aggregate definitions and version constraints](https://www.tigerdata.com/docs/build/continuous-aggregates/create-a-continuous-aggregate)
- [Real-time continuous aggregates](https://www.tigerdata.com/docs/learn/continuous-aggregates)
- [Gap-fill semantics and NULL versus interpolation](https://www.tigerdata.com/docs/reference/timescaledb/hyperfunctions/time_bucket_gapfill/time_bucket_gapfill)
- [Retention with continuous aggregates](https://www.tigerdata.com/docs/learn/data-lifecycle/data-retention/data-retention-with-continuous-aggregates)
- [Time bucket boundaries](https://www.tigerdata.com/docs/learn/data-lifecycle/time-buckets/about-time-buckets)
- [TimescaleDB 2.19 GRANT propagation](https://github.com/timescale/timescaledb/blob/2.19.3/src/process_utility.c)
- [TimescaleDB 2.19 compressed-column propagation](https://github.com/timescale/timescaledb/blob/2.19.3/tsl/src/compression/create.c)
