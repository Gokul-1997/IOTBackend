-- ── Migration 009: Make users.plant_id nullable ──
--
-- WHY: Migration 006 made plant_id nullable on 9 tables so that a
-- COMPANY_ADMIN (plant_id = NULL, company-wide scope) could write rows to
-- them, but missed the users table itself. As a result, company.service.js's
-- create() — which inserts the new company's auto-generated COMPANY_ADMIN
-- user with plant_id = NULL — has always failed with:
--   error 23502: null value in column "plant_id" of relation "users"
--   violates not-null constraint
-- meaning no new company could ever be created through the API.

ALTER TABLE users
  ALTER COLUMN plant_id DROP NOT NULL;

SELECT '=== Migration 009 complete ===' AS status;
