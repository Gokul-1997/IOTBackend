BEGIN;

-- Additive file catalogue; no legacy S3 references or disk files are deleted.
-- File bytes live below STORAGE_ROOT and require the same backup schedule as
-- PostgreSQL. Canonical URLs never contain the server hostname or an S3 URL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plants_id_company_media ON plants(id,company_id);
CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plant_id INTEGER,
  purpose VARCHAR(40) NOT NULL CHECK (purpose='machine-images'),
  storage_key TEXT NOT NULL UNIQUE,
  filename VARCHAR(45) NOT NULL,
  mime_type VARCHAR(20) NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Cancelled drafts and superseded images retain their tenant/file backup
  -- even when an otherwise empty plant is deleted. Clear only the plant;
  -- the company foreign key continues to protect company ownership.
  CONSTRAINT media_assets_plant_tenant_fk FOREIGN KEY (plant_id,company_id) REFERENCES plants(id,company_id) ON DELETE SET NULL (plant_id),
  CONSTRAINT media_assets_company_filename_unique UNIQUE (company_id,filename),
  CONSTRAINT media_assets_filename_check CHECK (filename ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$'),
  CONSTRAINT media_assets_storage_key_check CHECK (storage_key = 'company-' || company_id || '/images/machines/' || filename)
);
CREATE INDEX IF NOT EXISTS media_assets_company_plant_created_idx ON media_assets(company_id,plant_id,created_at DESC);

COMMIT;
