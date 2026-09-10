-- ============================================================
-- 013_program_transfer_authorization.sql
-- Supervisor-authorised program transfer.
--
-- Closes two Phase 2 agreement requirements that shipped unbuilt:
--   "Program transfer is secured with OTP-based supervisor
--    authorization, with complete OTP and file-transfer audit logging."
--   "The system shall provide role-based access control for program
--    upload, download, and deletion operations."
--
-- Until now every /api/programs route carried only the generic `auth`
-- middleware: any authenticated user could push G-code to any machine
-- in their company. A wrong program on a controller can crash a
-- spindle or injure an operator.
--
-- Adds: machine_supervisors (who may authorise which machine),
--       transfer_authorizations (the OTP record + audit trail),
--       approval columns on program_transfers,
--       page:programs:* permissions granted to the system roles.
-- ============================================================

BEGIN;

-- ── Who may authorise a transfer to a given machine ──────────
--
-- Deliberately many-to-many. One setter/supervisor covers a subset of
-- machines (the client's "3 or 4 of 20"), and one machine can have
-- several supervisors — otherwise the night shift could never transfer.
--
-- NOT reusing operator_machine_assignments: that table links the
-- `operators` table (badge records with no login), and dashboard,
-- quality, oee and three report services join it to mean "who is
-- running this machine right now". Supervisors there would corrupt
-- those queries.
--
-- Authority comes from a row here, not from a role name. Companies can
-- call the person a Setter, a Supervisor or anything else; only the
-- assignment counts. That also sidesteps the fact that custom roles
-- can only be granted page:% keys, never the legacy machine.* keys the
-- backend actually enforces.
CREATE TABLE IF NOT EXISTS machine_supervisors (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id  INTEGER NOT NULL REFERENCES machines(id)  ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (machine_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_machine_supervisors_machine
  ON machine_supervisors(machine_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_machine_supervisors_user
  ON machine_supervisors(user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_machine_supervisors_company
  ON machine_supervisors(company_id);

-- ── The OTP record, and the OTP half of the audit log ────────
--
-- Lifecycle modelled on password_reset_tokens: the code is hashed with
-- SHA-256 before storage and never persisted or returned in plaintext.
--
-- attempts is capped in the service rather than in Redis on purpose —
-- both express-rate-limit limiters skip() when Redis is unavailable, so
-- a Redis outage would otherwise silently disable brute-force
-- protection on a safety control.
--
-- A verified authorisation stays reusable until expires_at rather than
-- being consumed on first use: the frontend answers FILE_EXISTS by
-- re-sending the whole batch with overwrite=true, and the supervisor
-- must not be asked to re-type the code on that second pass. `uses`
-- bounds the reuse.
CREATE TABLE IF NOT EXISTS transfer_authorizations (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id    INTEGER NOT NULL REFERENCES machines(id)  ON DELETE CASCADE,
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  code_hash     TEXT NOT NULL,
  channel       VARCHAR(10) NOT NULL DEFAULT 'EMAIL',
  sent_to       TEXT,
  program_ids   BIGINT[],
  attempts      INTEGER NOT NULL DEFAULT 0,
  uses          INTEGER NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  expires_at    TIMESTAMPTZ NOT NULL,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE transfer_authorizations
  DROP CONSTRAINT IF EXISTS transfer_authorizations_status_check;
ALTER TABLE transfer_authorizations
  ADD CONSTRAINT transfer_authorizations_status_check
  CHECK (status IN ('PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED'));

ALTER TABLE transfer_authorizations
  DROP CONSTRAINT IF EXISTS transfer_authorizations_channel_check;
ALTER TABLE transfer_authorizations
  ADD CONSTRAINT transfer_authorizations_channel_check
  CHECK (channel IN ('EMAIL', 'SMS'));

CREATE INDEX IF NOT EXISTS idx_transfer_auth_machine
  ON transfer_authorizations(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_auth_company
  ON transfer_authorizations(company_id, created_at DESC);

COMMENT ON COLUMN transfer_authorizations.code_hash IS
  'SHA-256 of the one-time code. The plaintext code is never stored.';
COMMENT ON COLUMN transfer_authorizations.sent_to IS
  'Masked destination (e.g. r***@stm.com) kept for the audit trail.';

-- ── Who approved, alongside who clicked ──────────────────────
-- transferred_by already records the initiator; these record the
-- supervisor who signed the transfer off. The agreement requires both.
ALTER TABLE program_transfers
  ADD COLUMN IF NOT EXISTS authorized_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS authorization_id BIGINT  REFERENCES transfer_authorizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS authorized_at    TIMESTAMPTZ;

COMMENT ON COLUMN program_transfers.authorized_by IS
  'Supervisor who authorised this transfer with an OTP (NULL for pre-013 rows).';

-- ── Permissions ──────────────────────────────────────────────
-- The programs module was never registered in APP_MODULES, so no
-- page:programs:* key has ever existed. seedPagePermissions() creates
-- the keys on boot but grants them only to SNT_SUPER, so the grants for
-- every other role must happen here. Skipping this would lock all
-- non-super users out of a page that works for them today — exactly the
-- failure mode that hid the Maintenance and Alarms nav entries.
INSERT INTO permissions (permission_key, description) VALUES
  ('page:programs:view',     'View Page — Program Transfer'),
  ('page:programs:upload',   'Upload to library — Program Transfer'),
  ('page:programs:transfer', 'Send to machine — Program Transfer'),
  ('page:programs:fetch',    'Fetch from machine — Program Transfer'),
  ('page:programs:delete',   'Delete — Program Transfer')
ON CONFLICT (permission_key) DO NOTHING;

-- View: everyone who can see machines today.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.role_name IN ('SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR','OPERATOR','VIEWER')
  AND p.permission_key = 'page:programs:view'
ON CONFLICT DO NOTHING;

-- Upload to the server library, fetch from a controller, send to a
-- machine: the production roles. Operators keep read-only access —
-- they initiate nothing, which is the point of the supervisor gate.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.role_name IN ('SNT_SUPER','COMPANY_ADMIN','MANAGER','SUPERVISOR')
  AND p.permission_key IN ('page:programs:upload','page:programs:transfer','page:programs:fetch')
ON CONFLICT DO NOTHING;

-- Deleting from the library stays with the admin tier.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.role_name IN ('SNT_SUPER','COMPANY_ADMIN')
  AND p.permission_key = 'page:programs:delete'
ON CONFLICT DO NOTHING;

COMMIT;
