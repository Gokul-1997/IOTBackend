-- 054 — what the report assistant may cost (22 Oct 2026 security review)
--
-- Every question the model reads is paid for by the platform, but 052 only
-- counted completed answers: a question that ended in a refusal or a
-- clarifying question was free, so a person could run the AI without end.
-- assistant_usage now also counts every question the model read (taken
-- before it is asked, against hard daily ceilings per person and per
-- company — assistant.allowance) and the tokens each person's questions
-- used, so the bill can be read per company and day:
--
--   SELECT company_id, day, SUM(questions), SUM(answers),
--          SUM(input_tokens), SUM(cached_tokens), SUM(output_tokens)
--     FROM assistant_usage GROUP BY 1, 2 ORDER BY 2 DESC, 1;
--
-- Existing rows start at 0. Nothing else changes.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE assistant_usage
  ADD COLUMN IF NOT EXISTS questions     INT    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS input_tokens  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'assistant_usage_counts_not_negative' AND conrelid = 'assistant_usage'::regclass) THEN
    ALTER TABLE assistant_usage ADD CONSTRAINT assistant_usage_counts_not_negative
      CHECK (questions >= 0 AND input_tokens >= 0 AND cached_tokens >= 0 AND output_tokens >= 0);
  END IF;
END $$;

COMMIT;

SELECT '=== Migration 054 complete ===' AS status;
