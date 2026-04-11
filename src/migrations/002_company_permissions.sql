-- ============================================================
-- COMPANY-LEVEL PAGE ACCESS CONTROL
-- Super user assigns page:module:action permissions per company
-- This replaces plan_features for page gating
-- ============================================================

-- Company permissions: which specific permissions a company has access to
CREATE TABLE IF NOT EXISTS company_permissions (
    id            SERIAL PRIMARY KEY,
    company_id    INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    permission_id INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted_by    INT REFERENCES users(id),          -- which SNT user granted it
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_company_permissions_company ON company_permissions(company_id);
