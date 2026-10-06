-- Undo 035. Stop the collector build that needs these tables first
-- (it refuses to start without them; the previous build does not use them).
-- telemetry_late holds readings nothing else has: export it before dropping
-- if they may be needed:  \copy telemetry_late TO 'telemetry_late.csv' CSV HEADER
BEGIN;
DROP TABLE IF EXISTS telemetry_late;
DROP TABLE IF EXISTS ingest_checkpoint;
DELETE FROM schema_migrations WHERE filename = '035_ingest_journal.sql';
COMMIT;
