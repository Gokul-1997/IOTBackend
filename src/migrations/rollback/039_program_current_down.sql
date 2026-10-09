-- Deploy the previous API before rollback: direct program endpoints require
-- this table. All uploaded program bytes and file history are retained.
BEGIN;
DROP TABLE IF EXISTS program_current;
DELETE FROM schema_migrations WHERE filename = '039_program_current.sql';
COMMIT;
