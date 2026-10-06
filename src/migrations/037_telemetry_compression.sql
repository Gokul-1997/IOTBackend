-- 037 — compress telemetry older than 7 days
--
-- telemetry_raw is 23 GB after 7 months of ~17 machines sending a reading
-- every ~5 s, and nothing is ever compressed or removed. At 100 machines
-- once a second it would grow by about 3 GB a day.
--
-- TimescaleDB keeps each machine's readings of a day together, column by
-- column. Measured in staging on a day of 100 machines at 1 Hz (TimescaleDB
-- 2.30; production runs 2.19): 803 MB → 38 MB (21×). Dashboard queries on
-- compressed days: one machine's timeline 20 → 18 ms, spindle trend 1.7 →
-- 1.1 ms, all machines' hourly condition averages 360 → 115 ms; the Energy
-- meter-reading lookup 0.3 → 17 ms (compressed days have no row indexes).
--
-- Only days older than 7 days are compressed; today's and recent readings
-- stay as they are, so live screens and the collector are unaffected.
-- Readings arriving very late go to telemetry_late (035), not into old days.
--
-- Rollback: rollback/037_telemetry_compression_down.sql (decompresses
-- everything first — needs the disk space back).
BEGIN;
ALTER TABLE telemetry_raw SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'machine_id',
  timescaledb.compress_orderby   = 'received_at DESC'
);
SELECT add_compression_policy('telemetry_raw', INTERVAL '7 days', if_not_exists => true);
COMMIT;

SELECT '=== Migration 037 complete: chunks older than 7 days compress in the background ===' AS status;
