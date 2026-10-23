-- 058 — STM Mexa AI: S&T sets how much each company may use it (23 Oct 2026)
--
-- The user: "only the super admin decides how much the AI is used — up or
-- down — not the company side". assistant_settings now holds what S&T set
-- for one company; the company admin no longer sets anything:
--   daily_limit           answers a day for each person (already here: a
--                         figure a company admin chose stays until S&T
--                         changes it)
--   company_daily_limit   questions a day for the whole company
--   monthly_budget_usd    what the company's questions may cost in a
--                         calendar month, in US$
-- NULL means the platform's default (50 a day, US$5 a month); the server's
-- ASSISTANT_* ceilings bound whatever is stored.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assistant_settings
  ADD COLUMN IF NOT EXISTS company_daily_limit INT CHECK (company_daily_limit BETWEEN 0 AND 100000),
  ADD COLUMN IF NOT EXISTS monthly_budget_usd NUMERIC(10, 2) CHECK (monthly_budget_usd BETWEEN 0 AND 100000);

COMMIT;

SELECT '=== Migration 058 complete ===' AS status;
