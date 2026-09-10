-- 015 — Back up the program on the machine before replacing it.
--
-- Sending a program to a controller that already holds one under the same
-- number destroys the old one. Until now the only protection was a
-- confirmation dialog: the operator clicked "Overwrite" and whatever was on
-- the machine was gone, including edits made at the panel that had never
-- been saved anywhere else. On a CNC those edits are often the real
-- program — offsets tuned against the actual part.
--
-- The flow is now: read the existing program off the machine, store it, and
-- only then send the new one. Nothing is overwritten that has not been kept.
--
-- Additive and backward-compatible. Existing rows keep working: is_backup
-- defaults FALSE, so every program already in the library stays a normal
-- one and no query that predates this migration changes meaning.

BEGIN;

/* ── programs: a backup is a program, with provenance ───────────────────
   Deliberately not a separate table. A backup has to be sendable — the
   whole point is putting it back on the machine when the new program turns
   out to be wrong — so it needs to be the same kind of row the transfer
   code already knows how to read. A separate table would mean duplicating
   the transfer path for backups, and the version that gets exercised less
   is the one that breaks when it is finally needed.                       */
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS is_backup            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS backup_of_machine_id INT REFERENCES machines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS backup_taken_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS backup_of_program_id BIGINT REFERENCES programs(id) ON DELETE SET NULL;

COMMENT ON COLUMN programs.is_backup IS
  'TRUE when this row is a copy read off a controller immediately before it was overwritten.';
COMMENT ON COLUMN programs.backup_of_machine_id IS
  'The machine this backup was read from.';
COMMENT ON COLUMN programs.backup_of_program_id IS
  'The library program whose transfer caused this backup to be taken.';

/* The program list must not fill up with backups — an operator looking for
   something to send should see the programs they curate, not a copy of
   every overwrite. The list filters on is_backup = FALSE, so it needs an
   index that matches that predicate. */
CREATE INDEX IF NOT EXISTS idx_programs_company_active
  ON programs (company_id, created_at DESC)
  WHERE is_active = TRUE AND is_backup = FALSE;

/* Finding a machine's backup history is its own question, and answering it
   by scanning every program in the company would get slower with each
   overwrite. */
CREATE INDEX IF NOT EXISTS idx_programs_backups
  ON programs (backup_of_machine_id, backup_taken_at DESC)
  WHERE is_backup = TRUE;

/* ── program_transfers: which backup belongs to which transfer ────────── */
ALTER TABLE program_transfers
  ADD COLUMN IF NOT EXISTS backup_program_id BIGINT REFERENCES programs(id) ON DELETE SET NULL;

COMMENT ON COLUMN program_transfers.backup_program_id IS
  'The program read off the machine before this transfer replaced it. NULL when nothing was there to replace.';

COMMIT;
