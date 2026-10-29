BEGIN;
-- Dropping the source marker would hide independent measurements from totals.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM energy_meter_readings WHERE standalone) THEN
  RAISE EXCEPTION 'Cannot remove sparse energy support while standalone measurements exist. Export and reconcile them before rollback.';
 END IF;
END $$;
DROP VIEW IF EXISTS energy_observations;
DROP INDEX IF EXISTS idx_energy_meter_standalone_company_machine_time;
ALTER TABLE energy_meter_readings DROP COLUMN IF EXISTS standalone;
ALTER TABLE energy_meter_readings DROP COLUMN IF EXISTS standalone_fields;
COMMIT;
