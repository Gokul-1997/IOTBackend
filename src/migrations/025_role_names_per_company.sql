-- ============================================================
-- 025_role_names_per_company.sql
--
-- Each company owns its roles (the AWS-style model agreed on 2026-09-21):
-- a company admin creates roles for their own company, from scratch or by
-- copying a default. role_name was UNIQUE across the whole platform, so the
-- first company to create "Line Lead" — or to copy SUPERVISOR as
-- "Supervisor Night" — took the name from every other company.
--
-- After this:
--   * default and platform roles (company_id NULL): one of each name,
--     exactly as before.
--   * a company's own roles: unique within that company, ignoring case.
--     Two companies may each have a "Line Lead".
--
-- The CHECK is the database's half of a rule the service also enforces:
-- auth.service, role.middleware, access.middleware and alarm routing grant
-- privilege by role NAME. Once names stop being globally unique, a company
-- role called SNT_SUPER would make its holder a platform super admin. No
-- code path can create one; this makes sure no future one can either.
--
-- Code on origin/Gokul works before and after this migration. Before it, a
-- name already used by another company is refused with a clear 409.
--
-- SAFE TO RE-RUN.
-- ============================================================

BEGIN;

-- Refuse to proceed if any company role already holds a privileged name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles
              WHERE company_id IS NOT NULL
                AND upper(role_name) IN ('SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN')) THEN
    RAISE EXCEPTION 'A company role uses a reserved name; rename it before applying 025';
  END IF;
END $$;

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_role_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS roles_system_name_uq
  ON roles (role_name) WHERE company_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS roles_company_name_uq
  ON roles (company_id, lower(role_name)) WHERE company_id IS NOT NULL;

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_company_name_not_reserved;
ALTER TABLE roles ADD CONSTRAINT roles_company_name_not_reserved
  CHECK (company_id IS NULL OR upper(role_name) NOT IN ('SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN'));

COMMIT;
