BEGIN;

-- Do not destroy the catalogue for uploaded customer files. First roll back
-- the app or deliberately migrate/repoint the assets under a verified backup.
DO $$ BEGIN
  IF to_regclass('media_assets') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM media_assets LIMIT 1) THEN
      RAISE EXCEPTION 'Local media exists. Preserve/migrate those references before rolling back 046.';
    END IF;
  END IF;
END $$;
DROP TABLE IF EXISTS media_assets;
DROP INDEX IF EXISTS uq_plants_id_company_media;

COMMIT;
