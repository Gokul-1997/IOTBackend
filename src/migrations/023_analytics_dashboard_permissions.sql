-- Analytics dashboards become individually grantable.
--
-- All nine Phase 2 dashboards shared one guard, page:dashboard, so Manage Access
-- could not grant or revoke them one at a time, and at the API they were guarded
-- by `auth` alone. Each now has its own module (see APP_MODULES in
-- plans/plan.service.js) and its own permission keys.
--
-- WHAT THIS PRESERVES. A company that holds any page:dashboard:* grant today
-- can open all nine. It is given every new key, so the moment the frontend and
-- API start checking the new keys nobody has lost a page. S&T narrows them per
-- company afterwards, in Manage Access, which now lists them.
--
-- ORDER OF ROLLOUT matters:
--   1. apply this migration
--   2. wait ~15 minutes (an access token lives 15m; refresh re-reads role
--      permissions, so every signed-in session then carries the new keys)
--   3. deploy the API, then the frontend
-- Deploying either first would check keys nobody holds yet.
--
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING, and the permission rows
-- are exactly what seedPagePermissions() ('Sync Pages') would create, so
-- running that afterwards adds nothing.

INSERT INTO permissions (permission_key, description) VALUES
  ('page:analytics-factory:view', 'View Page — Factory Overall'),
  ('page:analytics-maintenance:view', 'View Page — Maintenance Dashboard'),
  ('page:analytics-preventive:view', 'View Page — Preventive Maintenance'),
  ('page:analytics-periodic:view', 'View Page — Periodic Maintenance'),
  ('page:analytics-periodic:export', 'Export (CSV/Excel) — Periodic Maintenance'),
  ('page:analytics-alarms:view', 'View Page — Alarm Report'),
  ('page:analytics-alarms:export', 'Export (CSV/Excel) — Alarm Report'),
  ('page:analytics-downtime:view', 'View Page — Downtime Analysis'),
  ('page:analytics-downtime:export', 'Export (CSV/Excel) — Downtime Analysis'),
  ('page:analytics-operators:view', 'View Page — Operator Performance'),
  ('page:analytics-operators:export', 'Export (CSV/Excel) — Operator Performance'),
  ('page:analytics-oee:view', 'View Page — OEE Dashboard'),
  ('page:analytics-oee:export', 'Export (CSV/Excel) — OEE Dashboard'),
  ('page:analytics-energy:view', 'View Page — Energy Dashboard'),
  ('page:analytics-energy:export', 'Export (CSV/Excel) — Energy Dashboard'),
  ('page:analytics-energy:settings', 'Tariff Settings — Energy Dashboard')
ON CONFLICT (permission_key) DO NOTHING;

-- Companies that can open the dashboards today keep every one of them.
INSERT INTO company_permissions (company_id, permission_id)
SELECT DISTINCT cp.company_id, np.id
  FROM company_permissions cp
  JOIN permissions op ON op.id = cp.permission_id
                     AND op.permission_key LIKE 'page:dashboard:%'
  CROSS JOIN permissions np
 WHERE np.permission_key LIKE 'page:analytics-%'
ON CONFLICT DO NOTHING;

-- Roles that hold a dashboard permission today (SNT_SUPER, in production) keep
-- parity. Company admins are governed by the company grant alone — see
-- middleware/access.middleware.js — so they need no role rows, and no other
-- system role holds a dashboard key today, so none is invented for them.
INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, np.id
  FROM role_permissions rp
  JOIN permissions op ON op.id = rp.permission_id
                     AND op.permission_key LIKE 'page:dashboard:%'
  CROSS JOIN permissions np
 WHERE np.permission_key LIKE 'page:analytics-%'
ON CONFLICT DO NOTHING;
