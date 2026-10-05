-- Program Transfer: where each machine keeps its programs.
--
-- Every machine gets a program path — the folder on the machine side
-- (e.g. //CNC_MEM/USER/PATH1/ on a Fanuc) where its device saves a program
-- sent from the platform, and where it reads programs from for backups and
-- for the list of what is on the machine. The device is told the path on
-- every call (/ping and each job), so it is set in one place, the platform.
--
-- Each job keeps the path it was made with: changing a machine's path later
-- does not move a program already queued, and the history keeps saying
-- where each program went.
--
-- Nothing to carry over: the old flow's machines.ftp_dir is empty on every
-- machine (checked 6 Oct 2026).

BEGIN;

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS program_path VARCHAR(255);
COMMENT ON COLUMN machines.program_path IS
  'Program Transfer: the folder on the machine where its device saves and reads programs.';

ALTER TABLE program_jobs
  ADD COLUMN IF NOT EXISTS program_path VARCHAR(255);
COMMENT ON COLUMN program_jobs.program_path IS
  'The machine''s program path when the job was made: where the program went, or came from.';

COMMIT;

SELECT '=== Migration 031 complete ===' AS status;
