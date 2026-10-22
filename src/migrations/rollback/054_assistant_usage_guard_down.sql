-- Undo 054. The question counts and token figures go; answers stay (052).
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE assistant_usage DROP CONSTRAINT IF EXISTS assistant_usage_counts_not_negative;
ALTER TABLE assistant_usage
  DROP COLUMN IF EXISTS questions,
  DROP COLUMN IF EXISTS input_tokens,
  DROP COLUMN IF EXISTS cached_tokens,
  DROP COLUMN IF EXISTS output_tokens;
COMMIT;
