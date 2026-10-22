-- Undo 053. Company gateway tokens stop existing (a gateway needs machine
-- tokens again); backups they sent stay, only the link to the token goes.
-- SKIPPED uploads go back to "not reported": before 053 only the newest
-- upload of a machine counted, so nothing is sent twice. 049's leftovers
-- (program_gateways, program_files.gateway_id) are not 053's: left alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS idx_program_files_waiting;
UPDATE program_files SET delivery_status = NULL WHERE delivery_status = 'SKIPPED';
ALTER TABLE program_files DROP CONSTRAINT IF EXISTS program_files_delivery_status_check;
ALTER TABLE program_files ADD CONSTRAINT program_files_delivery_status_check
  CHECK (delivery_status IN ('DONE', 'FAILED'));
ALTER TABLE program_files DROP CONSTRAINT IF EXISTS program_files_gateway_token_tenant_fk;
ALTER TABLE program_files DROP COLUMN IF EXISTS gateway_token_id;
DROP TABLE IF EXISTS program_gateway_tokens;
COMMIT;
