-- ============================================================
-- ENTERPRISE RBAC + PLAN MIGRATION
-- Architecture:
--   S&T Super User → Companies → Plans → Roles → Users
-- ============================================================

-- ── 1. COMPANIES (Multi-Tenant) ─────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
    id          SERIAL PRIMARY KEY,
    company_code VARCHAR(50) UNIQUE NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    contact_email VARCHAR(150),
    contact_phone VARCHAR(30),
    address       TEXT,
    logo_url      TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. PLANS (Bronze / Silver / Gold + Custom) ───────────────
CREATE TABLE IF NOT EXISTS plans (
    id           SERIAL PRIMARY KEY,
    plan_code    VARCHAR(50) UNIQUE NOT NULL,   -- 'bronze','silver','gold'
    plan_name    VARCHAR(100) NOT NULL,
    tier         SMALLINT NOT NULL DEFAULT 1,   -- 1=bronze,2=silver,3=gold
    description  TEXT,
    max_users    INT NOT NULL DEFAULT 5,
    max_plants   INT NOT NULL DEFAULT 1,
    max_machines INT NOT NULL DEFAULT 10,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 3. PLAN PAGE FEATURES (which pages each plan allows) ─────
CREATE TABLE IF NOT EXISTS plan_features (
    id           SERIAL PRIMARY KEY,
    plan_id      INT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    feature_key  VARCHAR(150) NOT NULL,         -- e.g. 'page:machines'
    is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (plan_id, feature_key)
);

-- ── 4. COMPANY PLANS (company ↔ plan assignment + overrides) ─
CREATE TABLE IF NOT EXISTS company_plans (
    id          SERIAL PRIMARY KEY,
    company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plan_id     INT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    -- overrides (NULL means inherit from plan)
    max_users    INT,
    max_plants   INT,
    max_machines INT,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (company_id)   -- one active plan per company
);

-- ── 5. ADD company_id to EXISTING TABLES ────────────────────
ALTER TABLE plants
    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS user_type  VARCHAR(30) NOT NULL DEFAULT 'company_user';
    -- user_type: 'snt_super' | 'company_admin' | 'company_user'

ALTER TABLE roles
    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS is_system   BOOLEAN NOT NULL DEFAULT FALSE;
    -- is_system=true: built-in roles (SNT_SUPER, COMPANY_ADMIN etc.) — not deletable

-- ── 6. PERMISSIONS — CRUD per page ──────────────────────────
-- New format: page:<module>:<action>
-- e.g.  page:machines:view, page:machines:create, page:machines:edit, page:machines:delete
-- Existing page:dashboard etc. stay; new ones added during seed

-- ── 7. SEED DEFAULT PLANS ────────────────────────────────────
INSERT INTO plans (plan_code, plan_name, tier, description, max_users, max_plants, max_machines)
VALUES
  ('bronze', 'Bronze',  1, 'Starter plan — essential monitoring',         10,  1,  20),
  ('silver', 'Silver',  2, 'Growth plan — advanced analytics & reports',  50,  3, 100),
  ('gold',   'Gold',    3, 'Enterprise plan — unlimited features',        999, 99, 999)
ON CONFLICT (plan_code) DO NOTHING;

-- ── 8. SEED PLAN FEATURES ────────────────────────────────────
-- Bronze: basic pages only
INSERT INTO plan_features (plan_id, feature_key, is_enabled)
SELECT p.id, f.feature_key, f.is_enabled
FROM plans p
CROSS JOIN (VALUES
  ('page:dashboard',       true),
  ('page:dashboard:live',  true),
  ('page:machines',        true),
  ('page:operators',       true),
  ('page:shifts',          true),
  ('page:job',             true),
  ('page:quality',         false),
  ('page:oee-reports',     false),
  ('page:reports',         false),
  ('page:charts',          false),
  ('page:plants',          false),
  ('page:component',       true),
  ('page:assignments',     true),
  ('page:machine-shifts',  false),
  ('page:lines',           false),
  ('page:users',           true),
  ('page:roles',           false)
) AS f(feature_key, is_enabled)
WHERE p.plan_code = 'bronze'
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Silver: most pages
INSERT INTO plan_features (plan_id, feature_key, is_enabled)
SELECT p.id, f.feature_key, f.is_enabled
FROM plans p
CROSS JOIN (VALUES
  ('page:dashboard',       true),
  ('page:dashboard:live',  true),
  ('page:machines',        true),
  ('page:operators',       true),
  ('page:shifts',          true),
  ('page:job',             true),
  ('page:quality',         true),
  ('page:oee-reports',     true),
  ('page:reports',         true),
  ('page:charts',          true),
  ('page:plants',          true),
  ('page:component',       true),
  ('page:assignments',     true),
  ('page:machine-shifts',  true),
  ('page:lines',           true),
  ('page:users',           true),
  ('page:roles',           false)
) AS f(feature_key, is_enabled)
WHERE p.plan_code = 'silver'
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Gold: all pages
INSERT INTO plan_features (plan_id, feature_key, is_enabled)
SELECT p.id, f.feature_key, f.is_enabled
FROM plans p
CROSS JOIN (VALUES
  ('page:dashboard',       true),
  ('page:dashboard:live',  true),
  ('page:machines',        true),
  ('page:operators',       true),
  ('page:shifts',          true),
  ('page:job',             true),
  ('page:quality',         true),
  ('page:oee-reports',     true),
  ('page:reports',         true),
  ('page:charts',          true),
  ('page:plants',          true),
  ('page:component',       true),
  ('page:assignments',     true),
  ('page:machine-shifts',  true),
  ('page:lines',           true),
  ('page:users',           true),
  ('page:roles',           true)
) AS f(feature_key, is_enabled)
WHERE p.plan_code = 'gold'
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- ── 9. SEED SYSTEM ROLES ─────────────────────────────────────
INSERT INTO roles (role_name, description, is_system, company_id)
VALUES
  ('SNT_SUPER',      'S&T Super User — full god-mode access across all companies', true, NULL),
  ('COMPANY_ADMIN',  'Company Admin — manages users, roles, and settings for their company', true, NULL),
  ('MANAGER',        'Manager — manage production, view all reports', true, NULL),
  ('SUPERVISOR',     'Supervisor — supervise shifts and operators', true, NULL),
  ('OPERATOR',       'Operator — work on production tasks', true, NULL),
  ('VIEWER',         'Viewer — read-only access', true, NULL)
ON CONFLICT (role_name) DO NOTHING;

-- ── 10. UPDATE PERMISSIONS to CRUD format ────────────────────
-- For each module, create view/create/edit/delete permissions
-- (run the seed via role.service.js seedPagePermissions)
