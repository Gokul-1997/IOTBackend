# Energy flow and five-day retention

Consumption is displayed as **Units**, where **1 Unit = 1 kWh**. Database columns and API `kwh` properties keep their canonical units for compatibility. Instantaneous kW, reactive kVArh and apparent kVAh retain their own units.

The collector validates each supplied channel before updating counters. Database migration 070 applies matching physical admission bounds to typed meter observations and the four legacy electrical columns. Missing or rejected values remain null; valid zero and signed active/reactive power remain valid. These broad corruption guards are separate from configured operating alarm thresholds.

The read path is:

1. Sparse `energy_meter_readings` observations, with original measurement timestamps.
2. Independent latest values per channel in `energy_meter_latest`.
3. A bounded reconciliation worker validates cumulative-counter changes, preserving resets, rejected spikes and uncertain gaps.
4. Hour/day/month counter summaries and minute electrical summaries serve the dashboard. Unrefreshed minute ranges and partial boundary buckets read bounded source/fact ranges.

`ENERGY_V2_ENABLED` unset or `true` uses this path only for a company whose `energy_pipeline_state.ready` has been verified. Explicit `false` retains the legacy path. The automatic worker processes ready companies; explicit rebuild operations can process a company before cutover. Chart, shift and machine totals use the same validated counter facts. Unknown pricing or incomplete measurement coverage remains visible.

## Scoped maintenance

Migration 070 alone never enables retention or deletes history. The prepared maintenance tool is deliberately limited to **S AND T, company 4, five days**. It requires explicit environment and private backup paths:

```sh
node scripts/energy-five-day-maintenance.js --company-id 4 --days 5 --env-file .env --backup-dir /private/backup/energy
node --max-old-space-size=1024 scripts/energy-five-day-maintenance.js --company-id 4 --days 5 --env-file .env --backup-dir /private/backup/energy --stage cleanup --apply
node --max-old-space-size=1024 scripts/energy-five-day-maintenance.js --company-id 4 --days 5 --env-file .env --backup-dir /private/backup/energy --stage rebuild --apply
node scripts/energy-five-day-maintenance.js --company-id 4 --days 5 --env-file .env --backup-dir /private/backup/energy --stage verify --apply
```

The first command is read-only. Cleanup fixes a rolling 120-hour cutoff from the database clock, writes gzip JSONL backups with verified SHA-256 hashes before each committed batch, and checkpoints progress in a private manifest. Reuse that directory only to resume the same maintenance operation. PostgreSQL timestamps and integer keys are backed up as database-generated JSON text without JavaScript number conversion. Flat meter/CNC backups may omit SQL-null fields; restore those absent fields as SQL NULL. Audit payloads retain their complete JSON structure in backups.

Only company 4 energy readings and derived energy state are removed/rebuilt. Shared CNC rows retain every non-energy column. Production counts and runtime remain; only their old energy component is cleared. Old audit payloads lose recognized electrical fields while CNC data remains. Tariffs, meter configuration and other companies remain. Never use global `drop_chunks` for tenant-specific retention.

Deleting source rows does not clear stored Timescale summaries. Cleanup refreshes the entire original summary history through the public API, including compressed historical summaries, and restores compression/job schedules. Because this public API refreshes whole time buckets, the initial tool refuses historical refreshes when other companies have summaries in the affected history. Rebuild verifies source/fact parity and aggregate parity before enabling the company. A frozen certified cutover boundary allows newer live work to remain queued without claiming it is reconciled.

Enabled policies run a bounded retention sweep every minute through the API scheduler. The watermark advances only after source cleanup and summary refresh succeed. Migration guards prevent an old journal replay from restoring expired meter/legacy/shared energy data. Run one current API process with scheduled jobs enabled on the server; developer instances should retain `CRON_ENABLED=false`.

The initial cleanup/rebuild must finish before clearing `maintenance`. A failed stage leaves resumable backups and keeps the company unready. Do not mark readiness manually or baseline an unapplied migration. Restoring history requires reviewing the specific backup batches and temporarily disabling the affected retention policy; a code rollback alone does not restore deleted history.

## Verification

The Backend and collector test suites cover corrupt finite values, zero/signed measurements, sparse provenance, counter poisoning, tenant ownership, backup/rollback safety, and retention retries. The optional SQL fixture refuses non-local URLs:

```sh
node scripts/verify-energy-quality-migration.js postgres://codex@127.0.0.1:45473/postgres
```

Frontend energy tests cover Units, five-day defaults, unavailable corrupt readings, request reuse across tabs and date/timezone boundaries. Deploy the built Angular assets and restart the current API/collector after pulling all three repositories; Git push runs CI and does not deploy these services.
