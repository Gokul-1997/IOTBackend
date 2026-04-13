-- ── Add company_id to all master data tables ──────────────────

-- Machines
ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

UPDATE machines m
  SET company_id = p.company_id
  FROM plants p
  WHERE m.plant_id = p.id AND m.company_id IS NULL;

-- Shifts
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

UPDATE shifts s
  SET company_id = p.company_id
  FROM plants p
  WHERE s.plant_id = p.id AND s.company_id IS NULL;

-- Operators
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

UPDATE operators o
  SET company_id = p.company_id
  FROM plants p
  WHERE o.plant_id = p.id AND o.company_id IS NULL;

-- Components
ALTER TABLE components
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

UPDATE components c
  SET company_id = p.company_id
  FROM plants p
  WHERE c.plant_id = p.id AND c.company_id IS NULL;

-- Line
ALTER TABLE line
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

UPDATE line l
  SET company_id = p.company_id
  FROM plants p
  WHERE l.plant_id = p.id AND l.company_id IS NULL;

-- machine_current_job
ALTER TABLE machine_current_job
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

UPDATE machine_current_job j
  SET company_id = p.company_id
  FROM plants p
  WHERE j.plant_id = p.id AND j.company_id IS NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_machines_company ON machines(company_id);
CREATE INDEX IF NOT EXISTS idx_shifts_company ON shifts(company_id);
CREATE INDEX IF NOT EXISTS idx_operators_company ON operators(company_id);
CREATE INDEX IF NOT EXISTS idx_components_company ON components(company_id);
CREATE INDEX IF NOT EXISTS idx_line_company ON line(company_id);
CREATE INDEX IF NOT EXISTS idx_machine_current_job_company ON machine_current_job(company_id);
