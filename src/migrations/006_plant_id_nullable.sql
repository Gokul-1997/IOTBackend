-- ── Migration 006: Make plant_id nullable + add company_id to assignment tables ──
--
-- WHY: COMPANY_ADMIN users have plant_id = NULL (company-wide scope).
-- The old schema had plant_id NOT NULL on several tables, which means inserts
-- from a COMPANY_ADMIN context were failing (plant_id = NULL violates NOT NULL).
--
-- Also adds company_id to operator_machine_assignments and
-- operator_shift_assignments so they can be scoped correctly.

-- 1. Make plant_id nullable on tables that COMPANY_ADMINs write to
ALTER TABLE line
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE machines
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE shifts
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE operators
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE components
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE machine_shift_config
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE machine_current_job
  ALTER COLUMN plant_id DROP NOT NULL;

-- telemetry_raw: plant_id must be nullable because machines created by
-- COMPANY_ADMIN have plant_id = NULL. Without this, all their telemetry
-- is silently dropped by buffer.js and the DB INSERT would fail.
ALTER TABLE telemetry_raw
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE operator_machine_assignments
  ALTER COLUMN plant_id DROP NOT NULL;

ALTER TABLE operator_shift_assignments
  ALTER COLUMN plant_id DROP NOT NULL;

-- 2. Add company_id to operator assignment tables
ALTER TABLE operator_machine_assignments
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE operator_shift_assignments
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

-- 3. Backfill company_id from the linked operator's company
UPDATE operator_machine_assignments oma
  SET company_id = o.company_id
  FROM operators o
  WHERE oma.operator_id = o.id AND oma.company_id IS NULL;

UPDATE operator_shift_assignments osa
  SET company_id = o.company_id
  FROM operators o
  WHERE osa.operator_id = o.id AND osa.company_id IS NULL;

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_oma_company ON operator_machine_assignments(company_id);
CREATE INDEX IF NOT EXISTS idx_osa_company ON operator_shift_assignments(company_id);

SELECT '=== Migration 006 complete ===' AS status;
