-- Program Transfer through the machine's own device.
--
-- Until now the server reached into the factory: it opened FTP (or FOCAS)
-- to the controller's IP itself. That only works when the API server sits on
-- the shop LAN, it kept FTP passwords for every machine in plain text, and a
-- supervisor had to read out a one-time code before each send.
--
-- From 030 the small device at each machine — the one already posting
-- telemetry over MQTT — does the talking to the controller, and it reaches
-- the server only by HTTPS calls it makes itself (nothing in the factory is
-- opened to the outside):
--
--   new program   a user uploads it and picks the machine; it waits as a job
--                 until the device asks for work, downloads it, saves the
--                 program it replaces as a BACKUP and loads the new one
--   backup        the device uploads what is on the controller (tagged
--                 BACKUP), on its own or before an overwrite
--   fetch         a user asks for a program on the controller; the device
--                 uploads it (tagged FETCHED)
--
-- The files themselves live on the server's disk, in the ProgramTransfer
-- folder, one folder per machine IP (src/programs/storage.js). These tables
-- hold what is known about them.
--
-- The tables of the old flow (programs, program_transfers,
-- machine_supervisors, transfer_authorizations) are left as they are: they
-- hold the history up to today and nothing writes to them any more. The FTP
-- passwords are cleared — nothing uses them, and they were stored in clear.

BEGIN;

/* ── the device at each machine, and its token ──────────────────────────
   One token per machine at a time. The token itself is shown once, when it
   is made, and never stored: only its SHA-256, so a copy of this table does
   not let anyone act as a device. token_prefix ("mxd_3f9a…") is what a
   person sees to tell tokens apart.                                        */
CREATE TABLE IF NOT EXISTS program_devices (
  id            SERIAL PRIMARY KEY,
  company_id    INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id    INT          NOT NULL REFERENCES machines(id)  ON DELETE CASCADE,
  label         VARCHAR(100),
  token_prefix  VARCHAR(16)  NOT NULL,
  token_hash    CHAR(64)     NOT NULL UNIQUE,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ,
  last_seen_ip  VARCHAR(45),
  agent_version VARCHAR(50),
  revoked_at    TIMESTAMPTZ,
  revoked_by    INT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_program_devices_live_machine
  ON program_devices (machine_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_program_devices_company
  ON program_devices (company_id, machine_id);

/* ── every file kept in the ProgramTransfer folder ──────────────────────
   kind  NEW      uploaded by a user, to be sent to the machine
         BACKUP   read off the controller by the device
         FETCHED  read off the controller because a user asked for it
   A deleted file keeps its row (deleted_at) so the history still names it. */
CREATE TABLE IF NOT EXISTS program_files (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id    INT REFERENCES machines(id) ON DELETE SET NULL,
  folder        VARCHAR(120) NOT NULL,          -- relative to the ProgramTransfer root
  stored_name   VARCHAR(255) NOT NULL,          -- the file's name inside that folder
  program_name  VARCHAR(255) NOT NULL,          -- its name on the controller, e.g. O1234.nc
  kind          VARCHAR(10)  NOT NULL CHECK (kind IN ('NEW', 'BACKUP', 'FETCHED')),
  size_bytes    INT          NOT NULL,
  sha256        CHAR(64)     NOT NULL,
  uploaded_by   INT REFERENCES users(id) ON DELETE SET NULL,
  device_id     INT REFERENCES program_devices(id) ON DELETE SET NULL,
  job_id        BIGINT,                         -- FK added below, after program_jobs
  note          VARCHAR(255),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  deleted_by    INT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (folder, stored_name)
);

CREATE INDEX IF NOT EXISTS idx_program_files_machine
  ON program_files (machine_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_program_files_company
  ON program_files (company_id, created_at DESC);

/* ── the work handed to a device ────────────────────────────────────────
   action  SEND   put file_id on the controller as program_name
           FETCH  read program_name off the controller (the file arrives as
                  file_id, kind FETCHED)
   status  QUEUED → DELIVERED (the device took it) → DONE | FAILED
           QUEUED → CANCELLED (a user withdrew it before the device took it)
   machine_serial is copied so the history survives the machine.            */
CREATE TABLE IF NOT EXISTS program_jobs (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id      INT REFERENCES machines(id) ON DELETE SET NULL,
  machine_serial  VARCHAR(100),
  action          VARCHAR(10)  NOT NULL CHECK (action IN ('SEND', 'FETCH')),
  program_name    VARCHAR(255) NOT NULL,
  file_id         BIGINT REFERENCES program_files(id) ON DELETE SET NULL,
  backup_file_id  BIGINT REFERENCES program_files(id) ON DELETE SET NULL,
  overwrite       BOOLEAN      NOT NULL DEFAULT FALSE,
  status          VARCHAR(12)  NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED', 'DELIVERED', 'DONE', 'FAILED', 'CANCELLED')),
  message         TEXT,
  requested_by    INT REFERENCES users(id) ON DELETE SET NULL,
  device_id       INT REFERENCES program_devices(id) ON DELETE SET NULL,
  requested_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

-- what a device asks for every few seconds: the oldest queued job of its machine
CREATE INDEX IF NOT EXISTS idx_program_jobs_open
  ON program_jobs (machine_id, requested_at) WHERE status IN ('QUEUED', 'DELIVERED');
CREATE INDEX IF NOT EXISTS idx_program_jobs_company
  ON program_jobs (company_id, requested_at DESC);

ALTER TABLE program_files
  DROP CONSTRAINT IF EXISTS program_files_job_id_fkey;
ALTER TABLE program_files
  ADD CONSTRAINT program_files_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES program_jobs(id) ON DELETE SET NULL;

/* ── what is on the controller, as the device last reported it ──────── */
CREATE TABLE IF NOT EXISTS program_controller_files (
  machine_id   INT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  company_id   INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  files        JSONB        NOT NULL DEFAULT '[]'::jsonb,
  reported_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

/* ── the old flow's FTP passwords: unused from here on, kept in clear ── */
UPDATE machines SET ftp_pass = NULL WHERE ftp_pass IS NOT NULL;

COMMIT;

SELECT '=== Migration 030 complete ===' AS status;
