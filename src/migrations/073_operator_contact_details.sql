BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS date_of_birth DATE;

COMMENT ON COLUMN operators.phone_number IS 'Optional operator phone number; text preserves country codes and leading zeros.';
COMMENT ON COLUMN operators.date_of_birth IS 'Optional date of birth, stored as a calendar date without a time zone.';

COMMIT;
