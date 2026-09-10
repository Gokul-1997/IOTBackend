-- ============================================================
-- 008_program_transfer.sql
-- CNC Program Transfer (DNC over FTP for Fanuc / Mitsubishi)
-- Adds: machine network/FTP config, programs storage,
--       program transfer history log
-- ============================================================

BEGIN;

-- ============================================================
-- 1. MACHINE NETWORK / FTP CONFIG
--    Fanuc and Mitsubishi controllers expose a built-in FTP
--    server on the machine LAN port. These fields hold the
--    connection details used by the transfer service.
-- ============================================================
ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS ip_address  VARCHAR(45),
  ADD COLUMN IF NOT EXISTS ftp_port    INTEGER DEFAULT 21,
  ADD COLUMN IF NOT EXISTS ftp_user    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ftp_pass    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ftp_dir     VARCHAR(255);   -- target folder on the CNC (e.g. '/' or '/PROGRAM')

-- ============================================================
-- 2. PROGRAMS (uploaded G-code / NC files)
--    File content stored in DB — NC programs are small text
--    files (KB range), no external storage needed.
-- ============================================================
CREATE TABLE IF NOT EXISTS programs (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         VARCHAR(150) NOT NULL,           -- display name, e.g. 'O1234 - Flange Roughing'
  file_name    VARCHAR(255) NOT NULL,           -- original file name, e.g. O1234.nc
  content      BYTEA NOT NULL,                  -- raw G-code file bytes
  file_size    INTEGER NOT NULL DEFAULT 0,      -- bytes
  description  TEXT,
  uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_programs_company ON programs(company_id, created_at DESC);

-- ============================================================
-- 3. PROGRAM TRANSFER LOG
--    One row per transfer attempt (success or failure).
-- ============================================================
CREATE TABLE IF NOT EXISTS program_transfers (
  id             BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  program_id     BIGINT REFERENCES programs(id) ON DELETE SET NULL,
  machine_id     INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  program_name   VARCHAR(150),                  -- denormalised: survives program deletion
  file_name      VARCHAR(255),
  machine_serial VARCHAR(100),                  -- denormalised: survives machine deletion
  status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',  -- 'PENDING', 'SUCCESS', 'FAILED'
  error_message  TEXT,
  transferred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_program_transfers_company ON program_transfers(company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_transfers_machine ON program_transfers(machine_id, started_at DESC);

COMMIT;
