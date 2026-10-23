-- Undo 056: the service connections, their bills and readings go; 055's
-- company bill dates come back (empty).
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS energy_readings;
DROP TABLE IF EXISTS energy_bills;
DROP TABLE IF EXISTS energy_connections;
CREATE TABLE IF NOT EXISTS energy_billing (
  company_id    INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  updated_by    INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT energy_billing_period_length
    CHECK (period_end >= period_start + 6 AND period_end <= period_start + 92)
);
COMMIT;
