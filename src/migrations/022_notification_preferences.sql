-- Per-user notification preferences.
--
-- alert_preferences (migration 007) is company-wide and decides whether an
-- alarm/offline/low-OEE event creates a notification at all. This decides
-- whether a given user wants to see each notification TYPE once it exists —
-- the two are different questions at different scopes, and neither table
-- can stand in for the other.
--
-- One row per user, created lazily on first read (see notification.service.js
-- getPreferences) rather than at signup, so this migration adds no trigger
-- and every existing user is unaffected until they open Settings.

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id               INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_alarm          BOOLEAN NOT NULL DEFAULT TRUE,
  notify_maintenance    BOOLEAN NOT NULL DEFAULT TRUE,
  notify_ticket         BOOLEAN NOT NULL DEFAULT TRUE,
  notify_program_transfer BOOLEAN NOT NULL DEFAULT TRUE,
  notify_system         BOOLEAN NOT NULL DEFAULT TRUE,
  email_digest          BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
