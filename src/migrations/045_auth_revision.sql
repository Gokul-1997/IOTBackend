BEGIN;

-- Existing access tokens without a revision remain valid at revision zero.
-- Every authorization/password mutation advances the revision in its own
-- transaction; login and refresh sign the revision read before their grants.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_revision BIGINT NOT NULL DEFAULT 0;

COMMIT;
