-- One explicitly published program per machine. Device downloads read this
-- pointer repeatedly. Uploading a backup never changes it. Existing file
-- history stays intact; the first new publication selects the current file.
BEGIN;

CREATE TABLE IF NOT EXISTS program_current (
  machine_id INT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_id BIGINT NOT NULL REFERENCES program_files(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_program_current_company ON program_current (company_id, machine_id);
CREATE INDEX IF NOT EXISTS idx_program_current_file ON program_current (file_id);

COMMIT;
