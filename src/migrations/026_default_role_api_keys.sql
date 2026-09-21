-- ============================================================
-- 026_default_role_api_keys.sql
--
-- Part of the API still checks older machine.view-style keys (the machines,
-- lines, shifts and operators routes), and a page that loads one of those
-- lists for a dropdown or filter needs the matching key. Two things were
-- wrong with the default roles' copies of them:
--
--   * QUALITY was missing line.view. The Quality page loads its line filter
--     from /api/lines, so the role's one screen opened with a 403 behind it.
--   * SUPERVISOR held create/update on lines, operators and components,
--     granted by the old legacy seeder rather than by its definition. The
--     customer specified a view-only supervisor.
--
-- default-roles.js now defines every key a default role holds, derived
-- from its pages, and the app re-applies that on every start. This makes it
-- true now, before the new API is deployed. Touches only the five default
-- roles; no company role, company grant or user is changed.
--
-- SAFE TO RE-RUN.
-- ============================================================

BEGIN;

-- SUPERVISOR: grant what it needs, remove what it was never meant to hold
INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'SUPERVISOR' AND ro.company_id IS NULL
   AND p.permission_key IN ('machine.view', 'line.view', 'shift.view', 'component.view', 'operator.view')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'SUPERVISOR' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id
   AND p.permission_key <> ALL (ARRAY['page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-downtime:view', 'page:analytics-downtime:export', 'page:analytics-oee:view', 'page:analytics-oee:export', 'page:analytics-energy:view', 'page:oee-reports:view', 'page:oee-reports:oee', 'page:oee-reports:availability', 'page:oee-reports:performance', 'page:oee-reports:quality', 'page:oee-reports:export', 'page:charts:view', 'page:charts:partwise-chart', 'page:charts:hourly-chart', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart', 'machine.view', 'line.view', 'shift.view', 'component.view', 'operator.view']);

-- MAINTENANCE: grant what it needs, remove what it was never meant to hold
INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'MAINTENANCE' AND ro.company_id IS NULL
   AND p.permission_key IN ('machine.view', 'line.view', 'shift.view', 'component.view', 'operator.view')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'MAINTENANCE' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id
   AND p.permission_key <> ALL (ARRAY['page:dashboard:view', 'page:dashboard:partcount', 'page:dashboard:target', 'page:dashboard:utilization', 'page:dashboard:runtime', 'page:dashboard:operator', 'page:dashboard:status', 'page:dashboard:live:view', 'page:dashboard:live:power-consume', 'page:dashboard:live:feed-override-chart', 'page:dashboard:live:spindle-speed-chart', 'page:analytics-maintenance:view', 'page:analytics-alarms:view', 'page:analytics-alarms:export', 'page:analytics-preventive:view', 'page:analytics-periodic:view', 'page:analytics-periodic:export', 'page:analytics-energy:view', 'page:maintenance-report:view', 'page:maintenance-report:export', 'page:maintenance:view', 'page:maintenance:create', 'page:maintenance:edit', 'page:maintenance:delete', 'machine.view', 'line.view', 'shift.view', 'component.view', 'operator.view']);

-- QUALITY: grant what it needs, remove what it was never meant to hold
INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'QUALITY' AND ro.company_id IS NULL
   AND p.permission_key IN ('machine.view', 'shift.view', 'component.view', 'operator.view', 'line.view')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'QUALITY' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id
   AND p.permission_key <> ALL (ARRAY['page:analytics-oee:view', 'page:analytics-oee:export', 'page:quality:view', 'page:quality:oee-metrics', 'page:quality:production-cards', 'page:quality:hourly-chart', 'page:quality:edit', 'machine.view', 'shift.view', 'component.view', 'operator.view', 'line.view']);

-- SETTER: grant what it needs, remove what it was never meant to hold
INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'SETTER' AND ro.company_id IS NULL
   AND p.permission_key IN ('machine.view', 'component.view')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'SETTER' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id
   AND p.permission_key <> ALL (ARRAY['page:programs:view', 'page:programs:upload', 'page:programs:transfer', 'page:programs:fetch', 'machine.view', 'component.view']);

-- HR: grant what it needs, remove what it was never meant to hold
INSERT INTO role_permissions (role_id, permission_id)
SELECT ro.id, p.id FROM roles ro, permissions p
 WHERE ro.role_name = 'HR' AND ro.company_id IS NULL
   AND p.permission_key IN ('machine.view', 'shift.view', 'operator.view', 'operator.create', 'operator.update', 'operator.delete')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions rp USING permissions p, roles ro
 WHERE ro.role_name = 'HR' AND ro.company_id IS NULL AND rp.role_id = ro.id
   AND p.id = rp.permission_id
   AND p.permission_key <> ALL (ARRAY['page:analytics-operators:view', 'page:analytics-operators:export', 'page:operators:view', 'page:operators:create', 'page:operators:edit', 'page:operators:delete', 'machine.view', 'shift.view', 'operator.view', 'operator.create', 'operator.update', 'operator.delete']);

COMMIT;
