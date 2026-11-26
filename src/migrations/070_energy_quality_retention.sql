-- Broad electrical corruption guards and opt-in tenant energy-history policy.
-- Installing this migration never deletes existing rows or enables a policy.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS energy_history_policy (
 company_id INTEGER PRIMARY KEY REFERENCES companies(id),
 retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 31),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 maintenance BOOLEAN NOT NULL DEFAULT FALSE,
 retained_from TIMESTAMPTZ,
 last_swept_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON energy_history_policy FROM PUBLIC;
CREATE OR REPLACE FUNCTION energy_quality_valid(p_field TEXT,p_value FLOAT8) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
 WHEN p_field IN ('voltage') OR p_field ~ '^v([0-9]|_ln|_ll)' THEN p_value BETWEEN 0 AND 2000
 WHEN p_field IN ('current') OR p_field ~ '^i([0-9]|_avg)' THEN p_value BETWEEN 0 AND 10000
 WHEN p_field IN ('power') OR p_field ~ '^(kw|kvar)([0-9]|_)' THEN p_value BETWEEN -2000 AND 2000
 WHEN p_field ~ '^kva([0-9]|_)' THEN p_value BETWEEN 0 AND 2000
 WHEN p_field ~ '^pf([0-9]|_)' THEN p_value BETWEEN -1 AND 1
 WHEN p_field='energy' OR p_field ~ '^(kwh|kvarh|kvah)_' THEN p_value BETWEEN 0 AND 1000000000000
 WHEN p_field='frequency_hz' THEN p_value BETWEEN 0 AND 100
 WHEN p_field ~ '^thd_' THEN p_value BETWEEN 0 AND 10000
 WHEN p_field='run_hours' THEN p_value BETWEEN 0 AND 1000000
 WHEN p_field='aux_interrupts' THEN p_value BETWEEN 0 AND 2147483647
 ELSE FALSE END
$$;
CREATE OR REPLACE FUNCTION energy_history_cutoff(tenant INTEGER) RETURNS TIMESTAMPTZ
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
 SELECT GREATEST(retained_from,CURRENT_TIMESTAMP-make_interval(days=>retention_days))
 FROM energy_history_policy WHERE company_id=tenant AND enabled
$$;
CREATE OR REPLACE FUNCTION energy_guard_measurements() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE keep_from TIMESTAMPTZ; measured_at TIMESTAMPTZ; supplied JSONB;
BEGIN
 keep_from:=energy_history_cutoff(NEW.company_id);
 IF TG_TABLE_NAME='energy_meter_readings' THEN
  IF keep_from IS NOT NULL AND NEW.read_at<keep_from THEN RETURN NULL; END IF;
  IF NOT energy_quality_valid('v1n',NEW.v1n::float8) THEN NEW.v1n:=NULL; END IF;
  IF NOT energy_quality_valid('v2n',NEW.v2n::float8) THEN NEW.v2n:=NULL; END IF;
  IF NOT energy_quality_valid('v3n',NEW.v3n::float8) THEN NEW.v3n:=NULL; END IF;
  IF NOT energy_quality_valid('v_ln_avg',NEW.v_ln_avg::float8) THEN NEW.v_ln_avg:=NULL; END IF;
  IF NOT energy_quality_valid('v12',NEW.v12::float8) THEN NEW.v12:=NULL; END IF;
  IF NOT energy_quality_valid('v23',NEW.v23::float8) THEN NEW.v23:=NULL; END IF;
  IF NOT energy_quality_valid('v31',NEW.v31::float8) THEN NEW.v31:=NULL; END IF;
  IF NOT energy_quality_valid('v_ll_avg',NEW.v_ll_avg::float8) THEN NEW.v_ll_avg:=NULL; END IF;
  IF NOT energy_quality_valid('i1',NEW.i1::float8) THEN NEW.i1:=NULL; END IF;
  IF NOT energy_quality_valid('i2',NEW.i2::float8) THEN NEW.i2:=NULL; END IF;
  IF NOT energy_quality_valid('i3',NEW.i3::float8) THEN NEW.i3:=NULL; END IF;
  IF NOT energy_quality_valid('i_avg',NEW.i_avg::float8) THEN NEW.i_avg:=NULL; END IF;
  IF NOT energy_quality_valid('kw1',NEW.kw1::float8) THEN NEW.kw1:=NULL; END IF;
  IF NOT energy_quality_valid('kw2',NEW.kw2::float8) THEN NEW.kw2:=NULL; END IF;
  IF NOT energy_quality_valid('kw3',NEW.kw3::float8) THEN NEW.kw3:=NULL; END IF;
  IF NOT energy_quality_valid('kw_total',NEW.kw_total::float8) THEN NEW.kw_total:=NULL; END IF;
  IF NOT energy_quality_valid('kvar1',NEW.kvar1::float8) THEN NEW.kvar1:=NULL; END IF;
  IF NOT energy_quality_valid('kvar2',NEW.kvar2::float8) THEN NEW.kvar2:=NULL; END IF;
  IF NOT energy_quality_valid('kvar3',NEW.kvar3::float8) THEN NEW.kvar3:=NULL; END IF;
  IF NOT energy_quality_valid('kvar_total',NEW.kvar_total::float8) THEN NEW.kvar_total:=NULL; END IF;
  IF NOT energy_quality_valid('kva1',NEW.kva1::float8) THEN NEW.kva1:=NULL; END IF;
  IF NOT energy_quality_valid('kva2',NEW.kva2::float8) THEN NEW.kva2:=NULL; END IF;
  IF NOT energy_quality_valid('kva3',NEW.kva3::float8) THEN NEW.kva3:=NULL; END IF;
  IF NOT energy_quality_valid('kva_total',NEW.kva_total::float8) THEN NEW.kva_total:=NULL; END IF;
  IF NOT energy_quality_valid('pf1',NEW.pf1::float8) THEN NEW.pf1:=NULL; END IF;
  IF NOT energy_quality_valid('pf2',NEW.pf2::float8) THEN NEW.pf2:=NULL; END IF;
  IF NOT energy_quality_valid('pf3',NEW.pf3::float8) THEN NEW.pf3:=NULL; END IF;
  IF NOT energy_quality_valid('pf_avg',NEW.pf_avg::float8) THEN NEW.pf_avg:=NULL; END IF;
  IF NOT energy_quality_valid('frequency_hz',NEW.frequency_hz::float8) THEN NEW.frequency_hz:=NULL; END IF;
  IF NOT energy_quality_valid('kw_demand_max',NEW.kw_demand_max::float8) THEN NEW.kw_demand_max:=NULL; END IF;
  IF NOT energy_quality_valid('kw_demand_min',NEW.kw_demand_min::float8) THEN NEW.kw_demand_min:=NULL; END IF;
  IF NOT energy_quality_valid('kvar_demand_max',NEW.kvar_demand_max::float8) THEN NEW.kvar_demand_max:=NULL; END IF;
  IF NOT energy_quality_valid('kvar_demand_min',NEW.kvar_demand_min::float8) THEN NEW.kvar_demand_min:=NULL; END IF;
  IF NOT energy_quality_valid('kva_demand_max',NEW.kva_demand_max::float8) THEN NEW.kva_demand_max:=NULL; END IF;
  IF NOT energy_quality_valid('v1n_max',NEW.v1n_max::float8) THEN NEW.v1n_max:=NULL; END IF;
  IF NOT energy_quality_valid('v2n_max',NEW.v2n_max::float8) THEN NEW.v2n_max:=NULL; END IF;
  IF NOT energy_quality_valid('v3n_max',NEW.v3n_max::float8) THEN NEW.v3n_max:=NULL; END IF;
  IF NOT energy_quality_valid('v12_max',NEW.v12_max::float8) THEN NEW.v12_max:=NULL; END IF;
  IF NOT energy_quality_valid('v23_max',NEW.v23_max::float8) THEN NEW.v23_max:=NULL; END IF;
  IF NOT energy_quality_valid('v31_max',NEW.v31_max::float8) THEN NEW.v31_max:=NULL; END IF;
  IF NOT energy_quality_valid('i1_max',NEW.i1_max::float8) THEN NEW.i1_max:=NULL; END IF;
  IF NOT energy_quality_valid('i2_max',NEW.i2_max::float8) THEN NEW.i2_max:=NULL; END IF;
  IF NOT energy_quality_valid('i3_max',NEW.i3_max::float8) THEN NEW.i3_max:=NULL; END IF;
  IF NOT energy_quality_valid('kwh_import',NEW.kwh_import::float8) THEN NEW.kwh_import:=NULL; END IF;
  IF NOT energy_quality_valid('kwh_export',NEW.kwh_export::float8) THEN NEW.kwh_export:=NULL; END IF;
  IF NOT energy_quality_valid('kwh_total',NEW.kwh_total::float8) THEN NEW.kwh_total:=NULL; END IF;
  IF NOT energy_quality_valid('kvarh_import',NEW.kvarh_import::float8) THEN NEW.kvarh_import:=NULL; END IF;
  IF NOT energy_quality_valid('kvarh_export',NEW.kvarh_export::float8) THEN NEW.kvarh_export:=NULL; END IF;
  IF NOT energy_quality_valid('kvarh_total',NEW.kvarh_total::float8) THEN NEW.kvarh_total:=NULL; END IF;
  IF NOT energy_quality_valid('kvah_total',NEW.kvah_total::float8) THEN NEW.kvah_total:=NULL; END IF;
  IF NOT energy_quality_valid('run_hours',NEW.run_hours::float8) THEN NEW.run_hours:=NULL; END IF;
  IF NOT energy_quality_valid('aux_interrupts',NEW.aux_interrupts::float8) THEN NEW.aux_interrupts:=NULL; END IF;
  IF NOT energy_quality_valid('thd_v1n',NEW.thd_v1n::float8) THEN NEW.thd_v1n:=NULL; END IF;
  IF NOT energy_quality_valid('thd_v2n',NEW.thd_v2n::float8) THEN NEW.thd_v2n:=NULL; END IF;
  IF NOT energy_quality_valid('thd_v3n',NEW.thd_v3n::float8) THEN NEW.thd_v3n:=NULL; END IF;
  IF NOT energy_quality_valid('thd_v12',NEW.thd_v12::float8) THEN NEW.thd_v12:=NULL; END IF;
  IF NOT energy_quality_valid('thd_v23',NEW.thd_v23::float8) THEN NEW.thd_v23:=NULL; END IF;
  IF NOT energy_quality_valid('thd_v31',NEW.thd_v31::float8) THEN NEW.thd_v31:=NULL; END IF;
  IF NOT energy_quality_valid('thd_i1',NEW.thd_i1::float8) THEN NEW.thd_i1:=NULL; END IF;
  IF NOT energy_quality_valid('thd_i2',NEW.thd_i2::float8) THEN NEW.thd_i2:=NULL; END IF;
  IF NOT energy_quality_valid('thd_i3',NEW.thd_i3::float8) THEN NEW.thd_i3:=NULL; END IF;
  IF TG_OP='INSERT' AND NEW.v1n IS NULL AND NEW.v2n IS NULL AND NEW.v3n IS NULL AND NEW.v_ln_avg IS NULL AND NEW.v12 IS NULL AND NEW.v23 IS NULL AND NEW.v31 IS NULL AND NEW.v_ll_avg IS NULL AND NEW.i1 IS NULL AND NEW.i2 IS NULL AND NEW.i3 IS NULL AND NEW.i_avg IS NULL AND NEW.kw1 IS NULL AND NEW.kw2 IS NULL AND NEW.kw3 IS NULL AND NEW.kw_total IS NULL AND NEW.kvar1 IS NULL AND NEW.kvar2 IS NULL AND NEW.kvar3 IS NULL AND NEW.kvar_total IS NULL AND NEW.kva1 IS NULL AND NEW.kva2 IS NULL AND NEW.kva3 IS NULL AND NEW.kva_total IS NULL AND NEW.pf1 IS NULL AND NEW.pf2 IS NULL AND NEW.pf3 IS NULL AND NEW.pf_avg IS NULL AND NEW.frequency_hz IS NULL AND NEW.kw_demand_max IS NULL AND NEW.kw_demand_min IS NULL AND NEW.kvar_demand_max IS NULL AND NEW.kvar_demand_min IS NULL AND NEW.kva_demand_max IS NULL AND NEW.v1n_max IS NULL AND NEW.v2n_max IS NULL AND NEW.v3n_max IS NULL AND NEW.v12_max IS NULL AND NEW.v23_max IS NULL AND NEW.v31_max IS NULL AND NEW.i1_max IS NULL AND NEW.i2_max IS NULL AND NEW.i3_max IS NULL AND NEW.kwh_import IS NULL AND NEW.kwh_export IS NULL AND NEW.kwh_total IS NULL AND NEW.kvarh_import IS NULL AND NEW.kvarh_export IS NULL AND NEW.kvarh_total IS NULL AND NEW.kvah_total IS NULL AND NEW.run_hours IS NULL AND NEW.aux_interrupts IS NULL AND NEW.thd_v1n IS NULL AND NEW.thd_v2n IS NULL AND NEW.thd_v3n IS NULL AND NEW.thd_v12 IS NULL AND NEW.thd_v23 IS NULL AND NEW.thd_v31 IS NULL AND NEW.thd_i1 IS NULL AND NEW.thd_i2 IS NULL AND NEW.thd_i3 IS NULL THEN RETURN NULL; END IF;
  supplied:=to_jsonb(NEW);
  NEW.standalone_fields:=ARRAY(SELECT f FROM unnest(NEW.standalone_fields) f WHERE supplied->f IS NOT NULL AND supplied->f<>'null'::jsonb);
 ELSE
  measured_at:=COALESCE(to_timestamp(NEW.device_time),NEW.received_at);
  IF keep_from IS NOT NULL AND measured_at<keep_from THEN
   NEW.energy:=NULL;NEW.voltage:=NULL;NEW.current:=NULL;NEW.power:=NULL;
  ELSE
  IF NOT energy_quality_valid('energy',NEW.energy) THEN NEW.energy:=NULL; END IF;
  IF NOT energy_quality_valid('voltage',NEW.voltage) THEN NEW.voltage:=NULL; END IF;
  IF NOT energy_quality_valid('current',NEW.current) THEN NEW.current:=NULL; END IF;
  IF NOT energy_quality_valid('power',NEW.power) THEN NEW.power:=NULL; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Test schemas and production resolve the same explicitly owned objects.
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION energy_quality_valid(TEXT,FLOAT8) SET search_path=pg_catalog,%I',current_schema());
 EXECUTE format('ALTER FUNCTION energy_history_cutoff(INTEGER) SET search_path=pg_catalog,%I',current_schema());
 EXECUTE format('ALTER FUNCTION energy_guard_measurements() SET search_path=pg_catalog,%I',current_schema());
END $$;
REVOKE EXECUTE ON FUNCTION energy_guard_measurements() FROM PUBLIC;
DROP TRIGGER IF EXISTS energy_quality_guard ON energy_meter_readings;
CREATE TRIGGER energy_quality_guard BEFORE INSERT OR UPDATE ON energy_meter_readings
 FOR EACH ROW EXECUTE FUNCTION energy_guard_measurements();
DROP TRIGGER IF EXISTS energy_quality_guard ON telemetry_raw;
CREATE TRIGGER energy_quality_guard BEFORE INSERT OR UPDATE ON telemetry_raw
 FOR EACH ROW EXECUTE FUNCTION energy_guard_measurements();
-- The verified maintenance tool batches invalidation once per machine instead
-- of queuing the same device once for every deleted source row.
CREATE OR REPLACE FUNCTION energy_meter_deleted_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE point_ms DOUBLE PRECISION;
BEGIN
 IF OLD.company_id IS NULL OR current_setting('iot.energy_retention_cleanup',TRUE)='on' THEN RETURN OLD; END IF;
 point_ms:=EXTRACT(EPOCH FROM OLD.read_at)*1000;
 PERFORM pg_advisory_xact_lock(hashtextextended('energy-latest:'||OLD.company_id||':'||OLD.machine_id,0));
 UPDATE energy_meter_latest l SET
  field_values=COALESCE((SELECT jsonb_object_agg(j.key,l.field_values->j.key)
    FROM jsonb_each(l.field_observed_at) j WHERE (j.value::text)::double precision<>point_ms),'{}'),
  field_observed_at=COALESCE((SELECT jsonb_object_agg(j.key,j.value)
    FROM jsonb_each(l.field_observed_at) j WHERE (j.value::text)::double precision<>point_ms),'{}'),updated_at=NOW()
 WHERE l.company_id=OLD.company_id AND l.machine_id=OLD.machine_id;
 PERFORM energy_enqueue(OLD.company_id,OLD.machine_id,OLD.read_at);
 RETURN OLD;
END $$;

-- Retain CNC/audit payloads while removing only recognized meter channels.
CREATE OR REPLACE FUNCTION energy_strip_payload(p JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result JSONB; pair RECORD;
BEGIN
 IF jsonb_typeof(p)='array' THEN
  RETURN COALESCE((SELECT jsonb_agg(energy_strip_payload(value) ORDER BY ord)
   FROM jsonb_array_elements(p) WITH ORDINALITY a(value,ord)),'[]'::jsonb);
 ELSIF jsonb_typeof(p)<>'object' OR p IS NULL THEN RETURN p;
 END IF;
 result:='{}'::jsonb;
 FOR pair IN SELECT key,value FROM jsonb_each(p) LOOP
  IF lower(pair.key)=ANY(ARRAY['energy','energyformatted','energy_formatted','energy_unit',
   'energydata','energy_data','powerdata','power_data','voltage','voltage_unit','voltageformatted',
   'current','current_unit','currentformatted','power','power_unit','powerformatted','power_formatted',
   'active_power','reactive_power','apparent_power','power_factor','frequency','demand','thd','operating_data']) THEN CONTINUE; END IF;
  result:=result||jsonb_build_object(pair.key,energy_strip_payload(pair.value));
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION energy_guard_late_payload() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE keep_from TIMESTAMPTZ;
BEGIN
 keep_from:=energy_history_cutoff(NEW.company_id);
 IF keep_from IS NOT NULL AND COALESCE(to_timestamp(NEW.device_time),NEW.received_at)<keep_from THEN
  NEW.payload:=energy_strip_payload(NEW.payload);
 END IF;
 RETURN NEW;
END $$;
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION energy_strip_payload(JSONB) SET search_path=pg_catalog,%I',current_schema());
 EXECUTE format('ALTER FUNCTION energy_guard_late_payload() SET search_path=pg_catalog,%I',current_schema());
END $$;
REVOKE EXECUTE ON FUNCTION energy_guard_late_payload() FROM PUBLIC;
DROP TRIGGER IF EXISTS energy_history_guard ON telemetry_late;
CREATE TRIGGER energy_history_guard BEFORE INSERT OR UPDATE ON telemetry_late
 FOR EACH ROW EXECUTE FUNCTION energy_guard_late_payload();

-- A journal replay can still update production/gap counters after source
-- telemetry was admitted. Retention changes only their energy component.
CREATE OR REPLACE FUNCTION energy_guard_shared_history() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE keep_from TIMESTAMPTZ;
BEGIN
 keep_from:=energy_history_cutoff(NEW.company_id);
 IF TG_TABLE_NAME='production_hourly' THEN
  IF keep_from IS NOT NULL AND NEW.hour_start<keep_from THEN NEW.energy_kwh:=0; END IF;
 ELSE
  IF keep_from IS NOT NULL AND NEW.resumed_at<keep_from THEN NEW.unallocated_energy_kwh:=NULL; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION energy_guard_shared_history() SET search_path=pg_catalog,%I',current_schema());
 IF to_regclass('production_hourly') IS NOT NULL THEN
  EXECUTE 'DROP TRIGGER IF EXISTS energy_history_guard ON production_hourly';
  EXECUTE 'CREATE TRIGGER energy_history_guard BEFORE INSERT OR UPDATE ON production_hourly FOR EACH ROW EXECUTE FUNCTION energy_guard_shared_history()';
 END IF;
 IF to_regclass('ingest_gaps') IS NOT NULL THEN
  EXECUTE 'DROP TRIGGER IF EXISTS energy_history_guard ON ingest_gaps';
  EXECUTE 'CREATE TRIGGER energy_history_guard BEFORE INSERT OR UPDATE ON ingest_gaps FOR EACH ROW EXECUTE FUNCTION energy_guard_shared_history()';
 END IF;
END $$;
REVOKE EXECUTE ON FUNCTION energy_guard_shared_history() FROM PUBLIC;

COMMIT;
