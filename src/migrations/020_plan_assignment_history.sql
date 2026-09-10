-- 020 — Screens 11 & 13: subscription plan governance.
--
-- company_plans holds one row per company describing its current plan, and
-- assignPlan upserts it. That means every previous plan a company was on is
-- overwritten and gone: there is no way to answer "when did this company
-- move to Gold?", "who authorised it?", or "what were their limits last
-- quarter?" — all of which the agreement asks for under "maintain a history
-- of subscription plan assignments and changes for audit purposes".
--
-- A separate history table rather than versioning company_plans in place:
-- the quota middleware reads the current plan on every create, and that
-- lookup must stay a single-row hit rather than a "latest row" scan that
-- gets slower with each plan change.

BEGIN;

CREATE TABLE IF NOT EXISTS company_plan_history (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- what it became
  plan_id         INT REFERENCES plans(id) ON DELETE SET NULL,
  max_users       INT,
  max_plants      INT,
  max_machines    INT,
  expires_at      TIMESTAMPTZ,

  -- what it was, so a row explains a change on its own rather than only
  -- in comparison with the row before it
  previous_plan_id      INT REFERENCES plans(id) ON DELETE SET NULL,
  previous_max_users    INT,
  previous_max_plants   INT,
  previous_max_machines INT,

  changed_by      INT REFERENCES users(id) ON DELETE SET NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note            TEXT
);

COMMENT ON TABLE company_plan_history IS
  'Every plan assignment or limit change. Append-only: rows are never updated or deleted, because an audit trail that can be edited is not one.';
COMMENT ON COLUMN company_plan_history.previous_plan_id IS
  'The plan in force before this change. NULL on a company''s first assignment.';

/* The question this table exists to answer is always "what happened to this
   company, most recent first". */
CREATE INDEX IF NOT EXISTS idx_plan_history_company
  ON company_plan_history (company_id, changed_at DESC);

COMMIT;
