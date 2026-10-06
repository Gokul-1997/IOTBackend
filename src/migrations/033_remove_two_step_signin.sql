-- 033 — two-step sign-in removed (the client's request, 6 Oct 2026)
--
-- The platform no longer offers two-step sign-in: the setup page, the
-- /api/auth/2fa endpoints and their packages are gone. Sign-in never asked
-- for the code anyway — the setup page stored a secret that nothing checked.
--
-- What is left is user_2fa (migration 007): one row per person who set it
-- up, holding their TOTP secret in plain base32 and their backup codes. A
-- secret that guards nothing is still a secret on a production server, so the
-- table goes with the feature. One account had it switched on (checked
-- 6 Oct 2026); that person signs in with their password, as before.

BEGIN;

DROP TABLE IF EXISTS user_2fa;

COMMIT;

SELECT '=== Migration 033 complete ===' AS status;
