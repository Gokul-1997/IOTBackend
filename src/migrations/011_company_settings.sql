-- ============================================================
-- Phase 2 · company-level settings
--
-- Screen 1 (Factory Overall) and Screen 9 (Energy) both require energy
-- COST, not just kWh, and no tariff was stored anywhere. Hard-coding a
-- rate would silently produce wrong money figures for every tenant, so
-- it belongs with the company.
--
-- Also the home for Module F (Settings & Profile).
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS company_settings (
  company_id           INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,

  -- energy
  energy_rate_per_kwh  NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency             VARCHAR(10)   NOT NULL DEFAULT 'INR',

  -- targets / thresholds used by the analytics dashboards
  oee_target_percent   NUMERIC(5,2)  NOT NULL DEFAULT 85.00,

  updated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN company_settings.energy_rate_per_kwh IS
  'Tariff in `currency` per kWh. 0 means unset — dashboards must show cost as unavailable rather than as zero.';

-- Give every existing company a row so reads never have to handle a
-- missing one; rate stays 0 until someone sets it.
INSERT INTO company_settings (company_id)
SELECT id FROM companies
ON CONFLICT (company_id) DO NOTHING;

COMMIT;

SELECT '=== Migration 011 complete ===' AS status;
