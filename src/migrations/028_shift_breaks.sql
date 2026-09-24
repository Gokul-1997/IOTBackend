-- ============================================================
-- 028_shift_breaks.sql
--
-- When the breaks in a shift happen ("Tea Break 11:00-11:15").
--
-- shifts.break_minutes holds only a total, which is all OEE planned time
-- needs, so nothing could say WHEN a break falls. The machine page's shift
-- timeline marks each break across the running / idle / off bar, and the
-- Shifts screen lets the company enter them.
--
-- shifts.break_minutes is left exactly as it is: it is what planned time,
-- and so every OEE figure, is computed from. Break windows do not change
-- any number already reported.
--
-- Additive only: a new table, no existing row touched. Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS shift_breaks (
  id          SERIAL PRIMARY KEY,
  company_id  INT          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id    INT          NOT NULL REFERENCES shifts(id)    ON DELETE CASCADE,
  break_name  VARCHAR(60)  NOT NULL,
  start_time  TIME         NOT NULL,
  end_time    TIME         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT shift_breaks_has_length CHECK (start_time <> end_time)
);

CREATE INDEX IF NOT EXISTS idx_shift_breaks_shift ON shift_breaks (shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_breaks_company ON shift_breaks (company_id);

COMMENT ON TABLE shift_breaks IS
  'Break windows inside a shift, for the shift timeline. shifts.break_minutes remains the planned-time total OEE uses.';
