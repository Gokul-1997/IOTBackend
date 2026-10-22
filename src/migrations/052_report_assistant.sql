-- 052 — the report assistant ("STM Mexa AI", 22 Oct 2026)
--
-- companies.timezone    the company's day: a person's daily assistant
--                       allowance resets at midnight where the company is.
--                       India until a company admin sets another.
-- assistant_settings    the allowance per person per day, set by the
--                       company admin: 50 to start, 0 switches the assistant off
--                       for the company. No row means the default.
-- assistant_usage       completed answers per person per company day. A
--                       clarifying question, a refusal or a failure is not
--                       counted.
--
-- No conversation is stored on the server: the browser keeps the chat for
-- the session and sends it with each question.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';

CREATE TABLE IF NOT EXISTS assistant_settings (
  company_id  INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  daily_limit INT NOT NULL DEFAULT 50 CHECK (daily_limit BETWEEN 0 AND 1000),
  updated_by  INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assistant_usage (
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INT  NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  answers    INT  NOT NULL DEFAULT 0 CHECK (answers >= 0),
  PRIMARY KEY (user_id, company_id, day)
);
CREATE INDEX IF NOT EXISTS idx_assistant_usage_company_day ON assistant_usage (company_id, day);

COMMIT;

SELECT '=== Migration 052 complete ===' AS status;
