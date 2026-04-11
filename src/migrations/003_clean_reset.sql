-- ============================================================
-- CLEAN RESET: Two super admin users
-- gokuldsp01@gmail.com  → SNT_SUPER (admin pages only)
-- sandt@gmail.com  → Will be assigned to a company later
-- Run this ONCE to start fresh
-- ============================================================

-- 1. Clear all assignment tables
DELETE FROM company_permissions;
DELETE FROM user_roles;
DELETE FROM role_permissions;
DELETE FROM user_sessions;
DELETE FROM password_reset_tokens;

-- 2. Clear company related
DELETE FROM company_plans;
DELETE FROM plan_features;

-- 3. Clear custom roles (keep system roles)
DELETE FROM roles WHERE is_system = false;

-- 4. Clear all companies
DELETE FROM companies;

-- 5. Clear all permissions
DELETE FROM permissions;

-- 6. Delete ALL users except gokul and sandt
DELETE FROM users WHERE email NOT IN ('gokuldsp01@gmail.com', 'sandt@gmail.com');

-- 7. Set gokul as SNT Super User (admin only)
UPDATE users
SET user_type = 'snt_super',
    company_id = NULL,
    is_active = true,
    failed_login_attempts = 0,
    lock_until = NULL
WHERE email = 'gokuldsp01@gmail.com';

-- 8. Create sandt@gmail.com if not exists (password: Sandt@123)
INSERT INTO users (username, email, password_hash, user_type, is_active, plant_id)
VALUES (
  'sandt',
  'sandt@gmail.com',
  '$2b$10$8u9.AUH8Stm7.tjBBksjCuh4DsIniRHz.Lxsqb9XrgmmOZ/.aQk3.',
  'company_user',
  true,
  1
)
ON CONFLICT (email) DO UPDATE SET
  user_type = 'company_user',
  is_active = true,
  failed_login_attempts = 0,
  lock_until = NULL;

-- 9. Ensure system roles exist
INSERT INTO roles (role_name, description, is_system, company_id)
VALUES
  ('SNT_SUPER',      'S&T Super User — full god-mode access across all companies', true, NULL),
  ('COMPANY_ADMIN',  'Company Admin — manages users, roles, and settings for their company', true, NULL),
  ('MANAGER',        'Manager — manage production, view all reports', true, NULL),
  ('SUPERVISOR',     'Supervisor — supervise shifts and operators', true, NULL),
  ('OPERATOR',       'Operator — work on production tasks', true, NULL),
  ('VIEWER',         'Viewer — read-only access', true, NULL)
ON CONFLICT (role_name) DO NOTHING;

-- 10. Assign SNT_SUPER role to gokul
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = 'gokuldsp01@gmail.com' AND r.role_name = 'SNT_SUPER'
ON CONFLICT DO NOTHING;

-- 11. Re-seed default plans
INSERT INTO plans (plan_code, plan_name, tier, description, max_users, max_plants, max_machines)
VALUES
  ('bronze', 'Bronze',  1, 'Starter plan — basic monitoring',           10,  1,  20),
  ('silver', 'Silver',  2, 'Growth plan — advanced analytics',          50,  3, 100),
  ('gold',   'Gold',    3, 'Enterprise plan — unlimited features',     999, 99, 999)
ON CONFLICT (plan_code) DO NOTHING;

-- 12. Verify
SELECT '=== RESET COMPLETE ===' AS status;
SELECT 'User: ' || email || ' | Type: ' || user_type AS users FROM users ORDER BY email;
SELECT COUNT(*) AS total_users FROM users;
SELECT COUNT(*) AS total_companies FROM companies;
