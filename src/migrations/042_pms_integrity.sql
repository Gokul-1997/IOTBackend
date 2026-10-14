-- Add database guards for the job and preventive-engine invariants.
-- Never resolve old duplicates by deleting operational history. If this
-- preflight fails, review the named rows and close the duplicate work under
-- the application's normal workflow before retrying this migration.
BEGIN;

-- Only future jobs receive an observed cycle snapshot. Backfilling old jobs
-- from today's editable component would invent historical performance.
ALTER TABLE machine_current_job ADD COLUMN IF NOT EXISTS cycle_time_seconds NUMERIC;

DO $$
DECLARE duplicate_machine integer;
DECLARE duplicate_rule integer;
BEGIN
  SELECT machine_id INTO duplicate_machine
    FROM machine_current_job WHERE is_active = TRUE
   GROUP BY machine_id HAVING COUNT(*) > 1 LIMIT 1;
  IF duplicate_machine IS NOT NULL THEN
    RAISE EXCEPTION 'Multiple active jobs for machine %. Review and stop duplicate jobs before applying 042.', duplicate_machine;
  END IF;
  SELECT threshold_id INTO duplicate_rule
    FROM maintenance_tickets
   WHERE threshold_id IS NOT NULL AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS')
   GROUP BY company_id, machine_id, threshold_id HAVING COUNT(*) > 1 LIMIT 1;
  IF duplicate_rule IS NOT NULL THEN
    RAISE EXCEPTION 'Multiple live preventive tickets for rule %. Review and resolve duplicates before applying 042.', duplicate_rule;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_machine_current_job_active
  ON machine_current_job(machine_id) WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_preventive_live
  ON maintenance_tickets(company_id, machine_id, threshold_id)
  WHERE threshold_id IS NOT NULL AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS');

-- Preserve existing placement records for an explicit repair/validation
-- pass, while preventing new writes from crossing company/plant boundaries.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plants_id_company_pms ON plants(id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_line_id_company_plant_pms ON line(id, company_id, plant_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'line'::regclass AND conname = 'fk_line_plant_company_pms') THEN
    ALTER TABLE line ADD CONSTRAINT fk_line_plant_company_pms
      FOREIGN KEY (plant_id, company_id) REFERENCES plants(id, company_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'machines'::regclass AND conname = 'fk_machine_plant_company_pms') THEN
    ALTER TABLE machines ADD CONSTRAINT fk_machine_plant_company_pms
      FOREIGN KEY (plant_id, company_id) REFERENCES plants(id, company_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'machines'::regclass AND conname = 'fk_machine_line_placement_pms') THEN
    ALTER TABLE machines ADD CONSTRAINT fk_machine_line_placement_pms
      FOREIGN KEY (line_id, company_id, plant_id) REFERENCES line(id, company_id, plant_id) NOT VALID;
  END IF;
END $$;

COMMIT;
