-- Timescale runs parent row triggers on physical chunk names. Dispatch by
-- the logical row shape so inserts/updates work on both parents and chunks.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION energy_guard_measurements() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE keep_from TIMESTAMPTZ; measured_at TIMESTAMPTZ; supplied JSONB;
BEGIN
 keep_from:=energy_history_cutoff(NEW.company_id);
 IF to_jsonb(NEW) ? 'read_at' THEN
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
CREATE OR REPLACE FUNCTION energy_guard_shared_history() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE keep_from TIMESTAMPTZ;
BEGIN
 keep_from:=energy_history_cutoff(NEW.company_id);
 IF to_jsonb(NEW) ? 'hour_start' THEN
  IF keep_from IS NOT NULL AND NEW.hour_start<keep_from THEN NEW.energy_kwh:=0; END IF;
 ELSE
  IF keep_from IS NOT NULL AND NEW.resumed_at<keep_from THEN NEW.unallocated_energy_kwh:=NULL; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$BEGIN
 EXECUTE format('ALTER FUNCTION energy_guard_measurements() SET search_path=pg_catalog,%I',current_schema());
 EXECUTE format('ALTER FUNCTION energy_guard_shared_history() SET search_path=pg_catalog,%I',current_schema());
END $$;
REVOKE EXECUTE ON FUNCTION energy_guard_measurements(),energy_guard_shared_history() FROM PUBLIC;
COMMIT;
