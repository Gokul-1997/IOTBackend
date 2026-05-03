-- ============================================================
-- 007_new_features.sql
-- Run this migration to add all new feature tables
-- Adds: audit logging, alarms/alerts, downtime reason codes,
--       maintenance module, production planning,
--       in-app notifications, and 2FA (TOTP)
-- ============================================================

BEGIN;

-- ============================================================
-- 1. AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  action       VARCHAR(100) NOT NULL,        -- e.g. 'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT'
  resource     VARCHAR(100),                 -- e.g. 'machines', 'users', 'shifts'
  resource_id  VARCHAR(100),                 -- ID of the affected record
  old_value    JSONB,
  new_value    JSONB,
  ip_address   VARCHAR(45),
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company  ON audit_logs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user     ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource, resource_id);

-- ============================================================
-- 2. ALARMS / ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS machine_alarms (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  machine_id      INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  alarm_type      VARCHAR(50)  NOT NULL DEFAULT 'ALARM',   -- 'ALARM', 'OFFLINE', 'LOW_PERFORMANCE'
  severity        VARCHAR(20)  NOT NULL DEFAULT 'HIGH',    -- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  message         TEXT,
  is_resolved     BOOLEAN DEFAULT FALSE,
  resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_machine_alarms_company ON machine_alarms(company_id, is_resolved);
CREATE INDEX IF NOT EXISTS idx_machine_alarms_machine ON machine_alarms(machine_id, is_resolved);
CREATE INDEX IF NOT EXISTS idx_machine_alarms_created ON machine_alarms(created_at DESC);

-- Alert notification preferences per company
CREATE TABLE IF NOT EXISTS alert_preferences (
  id                        SERIAL PRIMARY KEY,
  company_id                INTEGER REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
  email_enabled             BOOLEAN DEFAULT TRUE,
  notify_on_alarm           BOOLEAN DEFAULT TRUE,
  notify_on_offline         BOOLEAN DEFAULT TRUE,
  notify_on_low_oee         BOOLEAN DEFAULT FALSE,
  low_oee_threshold         NUMERIC(5,2) DEFAULT 50.00,
  offline_threshold_seconds INTEGER DEFAULT 120,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. DOWNTIME REASON CODES
-- ============================================================
CREATE TABLE IF NOT EXISTS downtime_reasons (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  code       VARCHAR(20) NOT NULL,
  name       VARCHAR(100) NOT NULL,
  category   VARCHAR(50) NOT NULL DEFAULT 'UNPLANNED',  -- 'PLANNED', 'UNPLANNED', 'QUALITY', 'CHANGEOVER'
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_downtime_reasons_code ON downtime_reasons(company_id, code);

-- Downtime events logged per machine
CREATE TABLE IF NOT EXISTS downtime_events (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  machine_id         INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  shift_id           INTEGER REFERENCES shifts(id),
  downtime_reason_id INTEGER REFERENCES downtime_reasons(id) ON DELETE SET NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ,
  duration_seconds   INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
  ) STORED,
  notes              TEXT,
  entered_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_downtime_events_machine ON downtime_events(machine_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_downtime_events_company ON downtime_events(company_id, started_at DESC);

-- ============================================================
-- 4. MAINTENANCE MODULE
-- ============================================================
DO $$ BEGIN
  CREATE TYPE maintenance_type AS ENUM ('PREVENTIVE', 'CORRECTIVE', 'PREDICTIVE', 'INSPECTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE maintenance_status AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'OVERDUE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id                         SERIAL PRIMARY KEY,
  company_id                 INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  machine_id                 INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  title                      VARCHAR(200) NOT NULL,
  description                TEXT,
  maintenance_type           maintenance_type NOT NULL DEFAULT 'PREVENTIVE',
  scheduled_at               TIMESTAMPTZ NOT NULL,
  estimated_duration_minutes INTEGER DEFAULT 60,
  assigned_to                VARCHAR(200),
  status                     maintenance_status NOT NULL DEFAULT 'SCHEDULED',
  recurrence                 VARCHAR(50),   -- 'NONE', 'WEEKLY', 'MONTHLY', 'QUARTERLY'
  is_active                  BOOLEAN DEFAULT TRUE,
  created_by                 INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_machine ON maintenance_schedules(machine_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_company ON maintenance_schedules(company_id, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id                      BIGSERIAL PRIMARY KEY,
  maintenance_schedule_id INTEGER REFERENCES maintenance_schedules(id) ON DELETE SET NULL,
  company_id              INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  machine_id              INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  title                   VARCHAR(200) NOT NULL,
  maintenance_type        maintenance_type NOT NULL DEFAULT 'CORRECTIVE',
  started_at              TIMESTAMPTZ NOT NULL,
  completed_at            TIMESTAMPTZ,
  duration_minutes        INTEGER,
  technician_name         VARCHAR(200),
  work_performed          TEXT,
  parts_replaced          TEXT,
  cost                    NUMERIC(12,2),
  status                  maintenance_status NOT NULL DEFAULT 'COMPLETED',
  logged_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_maintenance_logs_machine ON maintenance_logs(machine_id, created_at DESC);

-- ============================================================
-- 5. PRODUCTION PLANNING
-- ============================================================
CREATE TABLE IF NOT EXISTS production_plans (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  line_id      INTEGER REFERENCES line(id) ON DELETE SET NULL,
  machine_id   INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  component_id INTEGER REFERENCES components(id) ON DELETE SET NULL,
  plan_date    DATE NOT NULL,
  shift_id     INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  planned_qty  INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_production_plans_company ON production_plans(company_id, plan_date DESC);
CREATE INDEX IF NOT EXISTS idx_production_plans_machine ON production_plans(machine_id, plan_date DESC);

-- ============================================================
-- 6. IN-APP NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL DEFAULT 'INFO',  -- 'ALARM', 'MAINTENANCE', 'INFO', 'WARNING'
  title      VARCHAR(200) NOT NULL,
  message    TEXT,
  link       VARCHAR(500),
  is_read    BOOLEAN DEFAULT FALSE,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_company ON notifications(company_id, created_at DESC);

-- ============================================================
-- 7. TWO-FACTOR AUTHENTICATION (2FA/TOTP)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_2fa (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  secret       VARCHAR(100) NOT NULL,   -- encrypted TOTP secret
  is_enabled   BOOLEAN DEFAULT FALSE,
  backup_codes TEXT[],                  -- array of hashed backup codes
  enabled_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. SEED DEFAULT DOWNTIME REASONS
-- (company_id NULL = global defaults, visible to all companies)
-- ============================================================
INSERT INTO downtime_reasons (company_id, code, name, category) VALUES
  (NULL, 'BRK', 'Machine Breakdown',   'UNPLANNED'),
  (NULL, 'MAT', 'Material Shortage',   'UNPLANNED'),
  (NULL, 'OPR', 'No Operator',         'UNPLANNED'),
  (NULL, 'QTY', 'Quality Issue',       'QUALITY'),
  (NULL, 'CHG', 'Tool/Die Changeover', 'CHANGEOVER'),
  (NULL, 'PMT', 'Planned Maintenance', 'PLANNED'),
  (NULL, 'ELC', 'Electrical Issue',    'UNPLANNED'),
  (NULL, 'PRG', 'Program Error',       'UNPLANNED'),
  (NULL, 'LNC', 'Lunch/Break',         'PLANNED'),
  (NULL, 'CLN', 'Cleaning/5S',         'PLANNED')
ON CONFLICT DO NOTHING;

COMMIT;
