-- Stop the new collector first. Export/verify a backup before removing nonempty gap history.
BEGIN;
DO $$ BEGIN
  IF to_regclass('ingest_gaps') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM ingest_gaps LIMIT 1) AND current_setting('iot.gap_backup_verified',true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Back up and verify ingest_gaps before rollback; set iot.gap_backup_verified=true only after verification';
    END IF;
  END IF;
END $$;
DROP TABLE IF EXISTS ingest_gaps;
COMMIT;
