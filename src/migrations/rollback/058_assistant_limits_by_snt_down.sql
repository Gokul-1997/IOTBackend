-- Undo 058. Each company is back on the platform's daily total and monthly
-- ceiling; the answers a day for each person (052) stay.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE assistant_settings
  DROP COLUMN IF EXISTS company_daily_limit,
  DROP COLUMN IF EXISTS monthly_budget_usd;
COMMIT;
