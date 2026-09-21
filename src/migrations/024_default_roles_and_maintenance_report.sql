-- ============================================================
-- 024_default_roles_and_maintenance_report.sql
--
-- Three changes the customer asked for on 2026-09-21:
--
--   1. Production Plans is removed. It was built but is not part of the
--      Phase 2 scope, and production_plans held no rows in any company.
--      The table is left in place — dropping it is a separate decision —
--      but its permission keys go, so it disappears from Manage Access
--      and from every role that held it.
--
--   2. A Maintenance Report page, which the agreement asks for: "the
--      system shall generate and export maintenance reports in Excel,
--      CSV, and PDF formats". Its own module, so it can be sold and
--      revoked separately from the Maintenance Dashboard.
--
--   3. Five default roles, identical in every company: SUPERVISOR,
--      MAINTENANCE, QUALITY, SETTER and HR. They are system roles
--      (company_id NULL) so one row serves every tenant. Admin is not
--      among them: COMPANY_ADMIN is governed by Manage Access instead.
--
-- This file matches src/roles/default-roles.js, which the app re-applies
-- on every start (role.service.syncDefaultRoles). Running it early just
-- means the roles exist before the new API is deployed.
--
-- SAFE TO RE-RUN. Nothing here touches a company's own roles, a company's
-- Manage Access grants, or any user's role assignment.
--
-- ROLLOUT: apply this, then deploy the API, then the frontend. Permissions
-- are baked into the JWT for up to 15 minutes, so a user already signed in
-- sees a new role's pages after their token refreshes.
-- ============================================================

BEGIN;

-- ─── 1. Production Plans: out of the catalogue ───────────────
-- Cascades to role_permissions and company_permissions by FK.
DELETE FROM permissions WHERE permission_key LIKE 'page:production-plans:%';

-- ─── 2. Maintenance Report: into the catalogue ───────────────
INSERT INTO permissions (permission_key, description) VALUES
  ('page:maintenance-report:view', 'View Page — Maintenance Report'),
  ('page:maintenance-report:export', 'Export (CSV/Excel) — Maintenance Report')
ON CONFLICT (permission_key) DO NOTHING;

-- S&T super users hold everything.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE r.role_name = 'SNT_SUPER'
   AND p.permission_key LIKE 'page:maintenance-report:%'
ON CONFLICT DO NOTHING;

-- A company that already has the Maintenance Dashboard gets the report
-- with it, so this does not silently remove a screen from anyone's plan.
-- A company with no grants at all is unrestricted and needs no row.
INSERT INTO company_permissions (company_id, permission_id)
SELECT DISTINCT cp.company_id, np.id
  FROM company_permissions cp
  JOIN permissions p  ON p.id = cp.permission_id
 CROSS JOIN permissions np
 WHERE p.permission_key LIKE 'page:analytics-maintenance:%'
   AND np.permission_key LIKE 'page:maintenance-report:%'
ON CONFLICT DO NOTHING;

-- ─── 3. The five default roles ───────────────────────────────
-- Each block: create or refresh the role, drop the page keys it should no
-- longer hold, then grant the ones it should. Legacy machine.view-style
-- keys are granted but never deleted — the older system roles share them.

-- SUPERVISOR
INSERT INTO roles (role_name, description, is_system, company_id) VALUES ('SUPERVISOR', 'Runs the shift: the live floor, downtime, OEE and energy, plus the OEE, chart and quality reports (read only).', true, NULL)
  ON CONFLICT (role_name) DO UPDATE SET description = EXCLUDED.description, is_system = true, updated_at = NOW()
  WHERE roles.company_id IS NULL;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'SUPERVISOR' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id AND p.permission_key LIKE 'page:%'
   AND p.permission_key <> ALL (ARRAY['page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-downtime:view', 'page:analytics-downtime:export', 'page:analytics-oee:view', 'page:analytics-oee:export', 'page:analytics-energy:view', 'page:oee-reports:view', 'page:oee-reports:oee', 'page:oee-reports:availability', 'page:oee-reports:performance', 'page:oee-reports:quality', 'page:oee-reports:export', 'page:charts:view', 'page:charts:partwise-chart', 'page:charts:hourly-chart', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart']);

INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'SUPERVISOR' AND ro.company_id IS NULL
   AND p.permission_key IN ('page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-downtime:view', 'page:analytics-downtime:export', 'page:analytics-oee:view', 'page:analytics-oee:export', 'page:analytics-energy:view', 'page:oee-reports:view', 'page:oee-reports:oee', 'page:oee-reports:availability', 'page:oee-reports:performance', 'page:oee-reports:quality', 'page:oee-reports:export', 'page:charts:view', 'page:charts:partwise-chart', 'page:charts:hourly-chart', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart', 'machine.view', 'line.view', 'shift.view', 'component.view', 'operator.view')
ON CONFLICT DO NOTHING;

-- MAINTENANCE
INSERT INTO roles (role_name, description, is_system, company_id) VALUES ('MAINTENANCE', 'Keeps the machines running: the maintenance, alarm, preventive, periodic and energy dashboards, and the maintenance report.', true, NULL)
  ON CONFLICT (role_name) DO UPDATE SET description = EXCLUDED.description, is_system = true, updated_at = NOW()
  WHERE roles.company_id IS NULL;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'MAINTENANCE' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id AND p.permission_key LIKE 'page:%'
   AND p.permission_key <> ALL (ARRAY['page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-maintenance:view', 'page:analytics-alarms:view', 'page:analytics-alarms:export', 'page:analytics-preventive:view', 'page:analytics-periodic:view', 'page:analytics-periodic:export', 'page:analytics-energy:view', 'page:maintenance-report:view', 'page:maintenance-report:export', 'page:maintenance:view', 'page:maintenance:create', 'page:maintenance:edit', 'page:maintenance:delete']);

INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'MAINTENANCE' AND ro.company_id IS NULL
   AND p.permission_key IN ('page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-maintenance:view', 'page:analytics-alarms:view', 'page:analytics-alarms:export', 'page:analytics-preventive:view', 'page:analytics-periodic:view', 'page:analytics-periodic:export', 'page:analytics-energy:view', 'page:maintenance-report:view', 'page:maintenance-report:export', 'page:maintenance:view', 'page:maintenance:create', 'page:maintenance:edit', 'page:maintenance:delete', 'machine.view', 'line.view', 'shift.view', 'component.view', 'operator.view')
ON CONFLICT DO NOTHING;

-- QUALITY
INSERT INTO roles (role_name, description, is_system, company_id) VALUES ('QUALITY', 'Owns quality: the OEE dashboard, and the quality screen including entry.', true, NULL)
  ON CONFLICT (role_name) DO UPDATE SET description = EXCLUDED.description, is_system = true, updated_at = NOW()
  WHERE roles.company_id IS NULL;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'QUALITY' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id AND p.permission_key LIKE 'page:%'
   AND p.permission_key <> ALL (ARRAY['page:analytics-oee:view', 'page:analytics-oee:export', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart', 'page:quality:edit']);

INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'QUALITY' AND ro.company_id IS NULL
   AND p.permission_key IN ('page:analytics-oee:view', 'page:analytics-oee:export', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart', 'page:quality:edit', 'machine.view', 'shift.view', 'component.view', 'operator.view')
ON CONFLICT DO NOTHING;

-- SETTER
INSERT INTO roles (role_name, description, is_system, company_id) VALUES ('SETTER', 'Sends programs to the machines.', true, NULL)
  ON CONFLICT (role_name) DO UPDATE SET description = EXCLUDED.description, is_system = true, updated_at = NOW()
  WHERE roles.company_id IS NULL;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'SETTER' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id AND p.permission_key LIKE 'page:%'
   AND p.permission_key <> ALL (ARRAY['page:programs:view', 'page:programs:upload', 'page:programs:transfer', 'page:programs:fetch']);

INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'SETTER' AND ro.company_id IS NULL
   AND p.permission_key IN ('page:programs:view', 'page:programs:upload', 'page:programs:transfer', 'page:programs:fetch', 'machine.view', 'component.view')
ON CONFLICT DO NOTHING;

-- HR
INSERT INTO roles (role_name, description, is_system, company_id) VALUES ('HR', 'Looks after the people: operator performance, and the operator records.', true, NULL)
  ON CONFLICT (role_name) DO UPDATE SET description = EXCLUDED.description, is_system = true, updated_at = NOW()
  WHERE roles.company_id IS NULL;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'HR' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id AND p.permission_key LIKE 'page:%'
   AND p.permission_key <> ALL (ARRAY['page:analytics-operators:view', 'page:analytics-operators:export', 'page:operators:view', 'page:operators:create', 'page:operators:edit', 'page:operators:delete']);

INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'HR' AND ro.company_id IS NULL
   AND p.permission_key IN ('page:analytics-operators:view', 'page:analytics-operators:export', 'page:operators:view', 'page:operators:create', 'page:operators:edit', 'page:operators:delete', 'machine.view', 'shift.view', 'operator.view', 'operator.create', 'operator.update', 'operator.delete')
ON CONFLICT DO NOTHING;

COMMIT;
