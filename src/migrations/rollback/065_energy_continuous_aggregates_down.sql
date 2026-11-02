-- Revert application reads first. Only derived read models are removed;
-- validated counter intervals and original meter readings remain untouched.
BEGIN;
DO $rollback$
DECLARE view_name TEXT; relation_kind "char"; is_continuous BOOLEAN;
BEGIN
  FOREACH view_name IN ARRAY ARRAY['energy_electrical_1m','energy_counter_monthly','energy_counter_daily','energy_counter_hourly'] LOOP
    SELECT c.relkind INTO relation_kind FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relname=view_name;
    is_continuous := FALSE;
    IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') THEN
      EXECUTE 'SELECT EXISTS(SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_schema=current_schema() AND view_name=$1)'
        INTO is_continuous USING view_name;
    END IF;
    IF is_continuous OR relation_kind='m' THEN
      -- TimescaleDB removes the materialization, its refresh/compression jobs
      -- and derived indexes together. No decompress-to-disk step is needed.
      EXECUTE format('DROP MATERIALIZED VIEW %I',view_name);
    ELSIF relation_kind='v' THEN
      EXECUTE format('DROP VIEW %I',view_name);
    END IF;
  END LOOP;
END
$rollback$;
DELETE FROM schema_migrations WHERE filename='065_energy_continuous_aggregates.sql';
COMMIT;
