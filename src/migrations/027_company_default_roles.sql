-- ============================================================
-- 027_company_default_roles.sql
--
-- Each company owns its default roles.
--
-- 024 created SUPERVISOR, MAINTENANCE, QUALITY, SETTER and HR as ONE shared,
-- locked set used by every company. The customer asked for this instead:
-- when S&T creates a company, the company gets its own copy of each default
-- role, limited to the pages S&T gave it; from then on the company admin
-- changes those roles as needed, and S&T takes no action on roles.
--
-- New companies get theirs in company.service.create. This does the same
-- for every existing company, then retires the shared set:
--
--   1. each company gets its own copy of each default role, holding only the
--      pages it has been granted. A name the company already uses is left
--      alone — that role is theirs.
--   2. every company role gets the older machine.view-style API keys its
--      pages need (default-roles.js LEGACY_FOR_PAGE) — the same thing the
--      app does whenever a role is saved.
--   3. every user holding a shared default role is moved to their own
--      company's copy of it. If any user cannot be moved, this stops and
--      changes nothing: removing the shared row would otherwise strip their
--      role silently (user_roles cascades on delete).
--   4. the shared rows are removed.
--
-- Touches no company's Manage Access, and no user's other roles.
-- ============================================================

BEGIN;

-- ─── 1. each company's own default roles ──────────────────────

-- SUPERVISOR
WITH created AS (
  INSERT INTO roles (role_name, description, company_id, is_system)
  SELECT 'SUPERVISOR', 'Runs the shift: the live floor, downtime, OEE and energy, plus the OEE, chart and quality reports (read only).', c.id, false FROM companies c
  ON CONFLICT DO NOTHING
  RETURNING id, company_id
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT cr.id, p.id
  FROM created cr
  JOIN permissions p ON p.permission_key = ANY (ARRAY['page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-downtime:view', 'page:analytics-downtime:export', 'page:analytics-oee:view', 'page:analytics-oee:export', 'page:analytics-energy:view', 'page:oee-reports:view', 'page:oee-reports:oee', 'page:oee-reports:availability', 'page:oee-reports:performance', 'page:oee-reports:quality', 'page:oee-reports:export', 'page:charts:view', 'page:charts:partwise-chart', 'page:charts:hourly-chart', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart'])
 WHERE NOT EXISTS (SELECT 1 FROM company_permissions x JOIN permissions xp ON xp.id = x.permission_id
                    WHERE x.company_id = cr.company_id AND xp.permission_key LIKE 'page:%')
    OR EXISTS (SELECT 1 FROM company_permissions cp
                WHERE cp.company_id = cr.company_id AND cp.permission_id = p.id)
ON CONFLICT DO NOTHING;

-- MAINTENANCE
WITH created AS (
  INSERT INTO roles (role_name, description, company_id, is_system)
  SELECT 'MAINTENANCE', 'Keeps the machines running: the maintenance, alarm, preventive, periodic and energy dashboards, and the maintenance report.', c.id, false FROM companies c
  ON CONFLICT DO NOTHING
  RETURNING id, company_id
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT cr.id, p.id
  FROM created cr
  JOIN permissions p ON p.permission_key = ANY (ARRAY['page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-maintenance:view', 'page:analytics-alarms:view', 'page:analytics-alarms:export', 'page:analytics-preventive:view', 'page:analytics-periodic:view', 'page:analytics-periodic:export', 'page:analytics-energy:view', 'page:maintenance-report:view', 'page:maintenance-report:export', 'page:maintenance:view', 'page:maintenance:create', 'page:maintenance:edit', 'page:maintenance:delete'])
 WHERE NOT EXISTS (SELECT 1 FROM company_permissions x JOIN permissions xp ON xp.id = x.permission_id
                    WHERE x.company_id = cr.company_id AND xp.permission_key LIKE 'page:%')
    OR EXISTS (SELECT 1 FROM company_permissions cp
                WHERE cp.company_id = cr.company_id AND cp.permission_id = p.id)
ON CONFLICT DO NOTHING;

-- QUALITY
WITH created AS (
  INSERT INTO roles (role_name, description, company_id, is_system)
  SELECT 'QUALITY', 'Owns quality: the OEE dashboard, and the quality screen including entry.', c.id, false FROM companies c
  ON CONFLICT DO NOTHING
  RETURNING id, company_id
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT cr.id, p.id
  FROM created cr
  JOIN permissions p ON p.permission_key = ANY (ARRAY['page:analytics-oee:view', 'page:analytics-oee:export', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart', 'page:quality:edit'])
 WHERE NOT EXISTS (SELECT 1 FROM company_permissions x JOIN permissions xp ON xp.id = x.permission_id
                    WHERE x.company_id = cr.company_id AND xp.permission_key LIKE 'page:%')
    OR EXISTS (SELECT 1 FROM company_permissions cp
                WHERE cp.company_id = cr.company_id AND cp.permission_id = p.id)
ON CONFLICT DO NOTHING;

-- SETTER
WITH created AS (
  INSERT INTO roles (role_name, description, company_id, is_system)
  SELECT 'SETTER', 'Sends programs to the machines.', c.id, false FROM companies c
  ON CONFLICT DO NOTHING
  RETURNING id, company_id
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT cr.id, p.id
  FROM created cr
  JOIN permissions p ON p.permission_key = ANY (ARRAY['page:programs:view', 'page:programs:upload', 'page:programs:transfer', 'page:programs:fetch'])
 WHERE NOT EXISTS (SELECT 1 FROM company_permissions x JOIN permissions xp ON xp.id = x.permission_id
                    WHERE x.company_id = cr.company_id AND xp.permission_key LIKE 'page:%')
    OR EXISTS (SELECT 1 FROM company_permissions cp
                WHERE cp.company_id = cr.company_id AND cp.permission_id = p.id)
ON CONFLICT DO NOTHING;

-- HR
WITH created AS (
  INSERT INTO roles (role_name, description, company_id, is_system)
  SELECT 'HR', 'Looks after the people: operator performance, and the operator records.', c.id, false FROM companies c
  ON CONFLICT DO NOTHING
  RETURNING id, company_id
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT cr.id, p.id
  FROM created cr
  JOIN permissions p ON p.permission_key = ANY (ARRAY['page:analytics-operators:view', 'page:analytics-operators:export', 'page:operators:view', 'page:operators:create', 'page:operators:edit', 'page:operators:delete'])
 WHERE NOT EXISTS (SELECT 1 FROM company_permissions x JOIN permissions xp ON xp.id = x.permission_id
                    WHERE x.company_id = cr.company_id AND xp.permission_key LIKE 'page:%')
    OR EXISTS (SELECT 1 FROM company_permissions cp
                WHERE cp.company_id = cr.company_id AND cp.permission_id = p.id)
ON CONFLICT DO NOTHING;

-- ─── 2. the API keys each company role's pages need ───────────

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, lp.id
  FROM role_permissions rp
  JOIN roles ro        ON ro.id = rp.role_id AND ro.company_id IS NOT NULL
  JOIN permissions pp  ON pp.id = rp.permission_id
  JOIN (VALUES
    ('page:machines:view', 'machine.view'),
    ('page:machines:view', 'line.view'),
    ('page:machines:create', 'machine.create'),
    ('page:machines:edit', 'machine.update'),
    ('page:machines:delete', 'machine.delete'),
    ('page:lines:view', 'line.view'),
    ('page:lines:create', 'line.create'),
    ('page:lines:edit', 'line.update'),
    ('page:lines:delete', 'line.delete'),
    ('page:shifts:view', 'shift.view'),
    ('page:shifts:create', 'shift.create'),
    ('page:shifts:edit', 'shift.update'),
    ('page:shifts:delete', 'shift.update'),
    ('page:operators:view', 'operator.view'),
    ('page:operators:view', 'shift.view'),
    ('page:operators:create', 'operator.create'),
    ('page:operators:edit', 'operator.update'),
    ('page:operators:delete', 'operator.delete'),
    ('page:component:view', 'component.view'),
    ('page:component:create', 'component.create'),
    ('page:component:edit', 'component.update'),
    ('page:component:delete', 'component.delete'),
    ('page:programs:view', 'machine.view'),
    ('page:assignments:view', 'operator.view'),
    ('page:assignments:view', 'shift.view'),
    ('page:machine-shifts:view', 'shift.view'),
    ('page:job:view', 'machine.view'),
    ('page:job:view', 'operator.view'),
    ('page:quality:view', 'line.view'),
    ('page:reports:view', 'machine.view'),
    ('page:reports:view', 'operator.view'),
    ('page:reports:view', 'shift.view')
  ) AS m(page_key, legacy_key) ON m.page_key = pp.permission_key
  JOIN permissions lp  ON lp.permission_key = m.legacy_key
ON CONFLICT DO NOTHING;

-- ─── 3. move users from the shared rows to their company's copy ─

INSERT INTO user_roles (user_id, role_id)
SELECT ur.user_id, own.id
  FROM user_roles ur
  JOIN roles shared ON shared.id = ur.role_id
                   AND shared.company_id IS NULL
                   AND shared.role_name IN ('SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR')
  JOIN users u      ON u.id = ur.user_id
  JOIN roles own    ON own.company_id = u.company_id
                   AND lower(own.role_name) = lower(shared.role_name)
ON CONFLICT DO NOTHING;

DO $$
DECLARE stranded INT;
BEGIN
  SELECT COUNT(*) INTO stranded
    FROM user_roles ur
    JOIN roles shared ON shared.id = ur.role_id
                     AND shared.company_id IS NULL
                     AND shared.role_name IN ('SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR')
   WHERE NOT EXISTS (
     SELECT 1 FROM user_roles mine
       JOIN roles own ON own.id = mine.role_id
       JOIN users u   ON u.id = mine.user_id
      WHERE mine.user_id = ur.user_id
        AND own.company_id = u.company_id
        AND lower(own.role_name) = lower(shared.role_name));
  IF stranded > 0 THEN
    RAISE EXCEPTION '% user(s) hold a shared default role and have no company copy to move to; nothing was changed', stranded;
  END IF;
END $$;

-- ─── 4. retire the shared set ─────────────────────────────────

DELETE FROM roles WHERE company_id IS NULL AND role_name IN ('SUPERVISOR', 'MAINTENANCE', 'QUALITY', 'SETTER', 'HR');

COMMIT;
