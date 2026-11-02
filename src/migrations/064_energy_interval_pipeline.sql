-- Additive energy read model. No source readings or old rollups are rewritten.
-- UTC timestamptz is the storage contract; reporting calendars use Asia/Kolkata.
BEGIN;

CREATE TABLE IF NOT EXISTS energy_pipeline_state (
 company_id INT PRIMARY KEY REFERENCES companies(id),
 ready BOOLEAN NOT NULL DEFAULT FALSE,
 backfilled_from TIMESTAMPTZ,
 backfilled_through TIMESTAMPTZ,
 algorithm_version INT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS energy_backfill_windows (
 company_id INT NOT NULL REFERENCES companies(id),
 from_at TIMESTAMPTZ NOT NULL,
 through_at TIMESTAMPTZ NOT NULL CHECK(through_at>from_at),
 completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(company_id,from_at,through_at)
);

CREATE TABLE IF NOT EXISTS energy_meter_rules (
 id BIGSERIAL PRIMARY KEY,
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 register TEXT NOT NULL CHECK(register IN ('kwh_total','kwh_import','kwh_export','kvarh_total','kvah_total')),
 effective_from TIMESTAMPTZ NOT NULL,
 max_rate_units_per_hour DOUBLE PRECISION NOT NULL DEFAULT 2000 CHECK(max_rate_units_per_hour>0 AND max_rate_units_per_hour<'Infinity'::float8),
 resolution DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(resolution>=0 AND resolution<'Infinity'::float8),
 max_gap_seconds INT NOT NULL DEFAULT 60 CHECK(max_gap_seconds BETWEEN 1 AND 86400),
 rollover_value DOUBLE PRECISION CHECK(rollover_value>0 AND rollover_value<'Infinity'::float8),
 rollover_margin_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.1 CHECK(rollover_margin_ratio>0 AND rollover_margin_ratio<=0.25),
 note TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(company_id,machine_id,register,effective_from),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id)
);
CREATE TABLE IF NOT EXISTS energy_counter_events (
 id BIGSERIAL PRIMARY KEY,
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 register TEXT NOT NULL CHECK(register IN ('kwh_total','kwh_import','kwh_export','kvarh_total','kvah_total')),
 effective_at TIMESTAMPTZ NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('reset','replacement')),
 baseline_value DOUBLE PRECISION CHECK(baseline_value>=0 AND baseline_value<'Infinity'::float8),
 note TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(company_id,machine_id,register,effective_at),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id)
);

CREATE TABLE IF NOT EXISTS energy_meter_latest (
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 field_values JSONB NOT NULL DEFAULT '{}',
 field_observed_at JSONB NOT NULL DEFAULT '{}',
 last_observed_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(company_id,machine_id),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id)
);

-- The inbox is intentionally an ordinary small table, not a hypertable.
-- Claimed work survives a worker crash; new writes can enqueue while it runs.
CREATE TABLE IF NOT EXISTS energy_reconcile_queue (
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 from_at TIMESTAMPTZ,
 claimed_from TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 attempts INT NOT NULL DEFAULT 0,
 last_error TEXT,
 PRIMARY KEY(company_id,machine_id),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id),
 CHECK(from_at IS NOT NULL OR claimed_from IS NOT NULL)
);

-- A correction to already materialized history must not disappear when raw
-- reconciliation completes. Readers bypass affected buckets until refreshed.
CREATE TABLE IF NOT EXISTS energy_refresh_queue (
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 from_at TIMESTAMPTZ NOT NULL,
 through_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 last_error TEXT,
 PRIMARY KEY(company_id,machine_id),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id),
 CHECK(through_at>=from_at)
);

CREATE TABLE IF NOT EXISTS energy_counter_intervals (
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 register TEXT NOT NULL CHECK(register IN ('kwh_total','kwh_import','kwh_export','kvarh_total','kvah_total')),
 observed_at TIMESTAMPTZ NOT NULL,
 interval_start TIMESTAMPTZ,
 -- Invalid source samples remain in the original table. A rejected derived
 -- fact can retain a finite negative sample, or NULL for non-finite input.
 raw_value DOUBLE PRECISION CHECK(ABS(raw_value)<'Infinity'::float8),
 delta DOUBLE PRECISION CHECK(delta>=0 AND delta<'Infinity'::float8),
 quality TEXT NOT NULL CHECK(quality IN ('baseline','measured','flat','regression','recovered','spike','gap','rollover','reset','config_change','invalid')),
 allocated BOOLEAN NOT NULL DEFAULT FALSE,
 shift_id INT REFERENCES shifts(id),
 measured_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(measured_seconds>=0 AND measured_seconds<'Infinity'::float8),
 baseline_value DOUBLE PRECISION,
 baseline_at TIMESTAMPTZ,
 uncertain BOOLEAN NOT NULL DEFAULT FALSE,
 epoch_at TIMESTAMPTZ,
 rule_id BIGINT,
 event_id BIGINT,
 state JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(company_id,machine_id,register,observed_at),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id),
 CHECK(interval_start IS NULL OR interval_start<=observed_at),
 CHECK(NOT allocated OR delta IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS energy_intervals_fleet_time ON energy_counter_intervals(company_id,register,observed_at DESC,machine_id);
CREATE TABLE IF NOT EXISTS energy_counter_state (
 company_id INT NOT NULL,
 machine_id INT NOT NULL,
 register TEXT NOT NULL,
 through_at TIMESTAMPTZ NOT NULL,
 state JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(company_id,machine_id,register),
 FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id)
);

-- Preserve existing invalid historical ownership for review; enforce valid
-- owners on new writes. Validation is an explicit preflight/backfill step.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='energy_meter_owner_v2' AND conrelid='energy_meter_readings'::regclass) THEN
  ALTER TABLE energy_meter_readings ADD CONSTRAINT energy_meter_owner_v2
    FOREIGN KEY(company_id,machine_id) REFERENCES machines(company_id,id) NOT VALID;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='energy_meter_company_required_v2' AND conrelid='energy_meter_readings'::regclass) THEN
  ALTER TABLE energy_meter_readings ADD CONSTRAINT energy_meter_company_required_v2 CHECK(company_id IS NOT NULL) NOT VALID;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS energy_meter_tenant_machine_time ON energy_meter_readings(company_id,machine_id,read_at DESC);

CREATE OR REPLACE FUNCTION energy_enqueue(p_company INT,p_machine INT,p_from TIMESTAMPTZ)
RETURNS VOID LANGUAGE SQL AS $$
 INSERT INTO energy_reconcile_queue(company_id,machine_id,from_at)
 VALUES(p_company,p_machine,p_from)
 ON CONFLICT(company_id,machine_id) DO UPDATE
 SET from_at=LEAST(energy_reconcile_queue.from_at,EXCLUDED.from_at),updated_at=NOW();
$$;

-- Only actual supplied values advance a channel's observation timestamp.
-- Repeated same-second aliases are already merged by the guarded source upsert.
CREATE OR REPLACE FUNCTION energy_meter_observed_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE incoming JSONB; existing JSONB; times JSONB; merged JSONB;
 channel TEXT; value JSONB; point_ms DOUBLE PRECISION; changed BOOLEAN:=FALSE;
 counter_changed BOOLEAN:=FALSE;
BEGIN
 IF NEW.company_id IS NULL OR NOT EXISTS(SELECT 1 FROM machines WHERE id=NEW.machine_id AND company_id=NEW.company_id) THEN
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('energy-latest:'||NEW.company_id||':'||NEW.machine_id,0));
 incoming:=to_jsonb(NEW)-ARRAY['machine_id','company_id','read_at','received_at','standalone','standalone_fields'];
 point_ms:=EXTRACT(EPOCH FROM NEW.read_at)*1000;
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 SELECT field_values,field_observed_at INTO existing,times FROM energy_meter_latest
  WHERE company_id=NEW.company_id AND machine_id=NEW.machine_id FOR UPDATE;
 existing:=COALESCE(existing,'{}');times:=COALESCE(times,'{}');merged:=existing;
 FOR channel,value IN SELECT j.key,j.value FROM jsonb_each(incoming) AS j LOOP
  IF TG_OP='UPDATE' AND channel IN ('kwh_total','kwh_import','kwh_export','kvarh_total','kvah_total')
    AND (to_jsonb(OLD)->channel) IS DISTINCT FROM value THEN counter_changed:=TRUE; END IF;
  IF value='null'::jsonb AND TG_OP='UPDATE' AND (times->>channel)::double precision=point_ms THEN
   merged:=merged-channel;times:=times-channel;changed:=TRUE;
  END IF;
  IF value='null'::jsonb OR value::text IN ('"NaN"','"Infinity"','"-Infinity"') THEN CONTINUE; END IF;
  IF channel IN ('kwh_total','kwh_import','kwh_export','kvarh_total','kvah_total') THEN
   IF TG_OP='INSERT' OR (to_jsonb(OLD)->channel) IS DISTINCT FROM value THEN counter_changed:=TRUE; END IF;
  END IF;
  IF COALESCE((times->>channel)::double precision,'-Infinity'::float8)<=point_ms THEN
   merged:=jsonb_set(merged,ARRAY[channel],value,TRUE);
   times:=jsonb_set(times,ARRAY[channel],to_jsonb(point_ms),TRUE);changed:=TRUE;
  END IF;
 END LOOP;
 IF changed THEN
  INSERT INTO energy_meter_latest(company_id,machine_id,field_values,field_observed_at,last_observed_at)
  VALUES(NEW.company_id,NEW.machine_id,merged,times,NEW.read_at)
  ON CONFLICT(company_id,machine_id) DO UPDATE SET
   field_values=EXCLUDED.field_values,field_observed_at=EXCLUDED.field_observed_at,
   last_observed_at=GREATEST(energy_meter_latest.last_observed_at,EXCLUDED.last_observed_at),updated_at=NOW();
 END IF;
 PERFORM energy_enqueue(NEW.company_id,NEW.machine_id,NEW.read_at);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS energy_meter_observed_v2 ON energy_meter_readings;
CREATE TRIGGER energy_meter_observed_v2 AFTER INSERT OR UPDATE ON energy_meter_readings
 FOR EACH ROW EXECUTE FUNCTION energy_meter_observed_v2();

-- Explicit operator corrections invalidate only matching latest channels.
-- Dropping a retained raw chunk does not run row DELETE triggers.
CREATE OR REPLACE FUNCTION energy_meter_deleted_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE point_ms DOUBLE PRECISION;
BEGIN
 IF OLD.company_id IS NULL THEN RETURN OLD; END IF;
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
DROP TRIGGER IF EXISTS energy_meter_deleted_v2 ON energy_meter_readings;
CREATE TRIGGER energy_meter_deleted_v2 AFTER DELETE ON energy_meter_readings
 FOR EACH ROW EXECUTE FUNCTION energy_meter_deleted_v2();

CREATE OR REPLACE FUNCTION energy_rule_changed_v2() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
  PERFORM energy_enqueue(OLD.company_id,OLD.machine_id,
   CASE WHEN TG_TABLE_NAME='energy_counter_events' THEN (to_jsonb(OLD)->>'effective_at')::timestamptz
        ELSE (to_jsonb(OLD)->>'effective_from')::timestamptz END);
 END IF;
 IF TG_OP<>'DELETE' THEN
  PERFORM energy_enqueue(NEW.company_id,NEW.machine_id,
   CASE WHEN TG_TABLE_NAME='energy_counter_events' THEN (to_jsonb(NEW)->>'effective_at')::timestamptz
        ELSE (to_jsonb(NEW)->>'effective_from')::timestamptz END);
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS energy_rule_changed_v2 ON energy_meter_rules;
CREATE TRIGGER energy_rule_changed_v2 AFTER INSERT OR UPDATE OR DELETE ON energy_meter_rules FOR EACH ROW EXECUTE FUNCTION energy_rule_changed_v2();
DROP TRIGGER IF EXISTS energy_event_changed_v2 ON energy_counter_events;
CREATE TRIGGER energy_event_changed_v2 AFTER INSERT OR UPDATE OR DELETE ON energy_counter_events FOR EACH ROW EXECUTE FUNCTION energy_rule_changed_v2();

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') THEN
  PERFORM create_hypertable('energy_counter_intervals','observed_at',chunk_time_interval=>INTERVAL '7 days',if_not_exists=>TRUE);
  ALTER TABLE energy_counter_intervals SET(timescaledb.compress,
   timescaledb.compress_segmentby='company_id,machine_id,register',timescaledb.compress_orderby='observed_at DESC');
  PERFORM add_compression_policy('energy_counter_intervals',INTERVAL '120 days',if_not_exists=>TRUE);
  ALTER TABLE energy_meter_readings SET(timescaledb.compress,
   timescaledb.compress_segmentby='company_id,machine_id',timescaledb.compress_orderby='read_at DESC');
  PERFORM add_compression_policy('energy_meter_readings',INTERVAL '30 days',if_not_exists=>TRUE);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='machine_api_user') THEN
  GRANT SELECT,INSERT,UPDATE ON energy_meter_latest,energy_reconcile_queue TO machine_api_user;
  GRANT EXECUTE ON FUNCTION energy_enqueue(INT,INT,TIMESTAMPTZ),energy_meter_observed_v2() TO machine_api_user;
 END IF;
END $$;
COMMENT ON TABLE energy_counter_intervals IS 'Derived validated differences. Counter decreases are unverified until a declared reset/replacement or configured rollover. Values are attributed to interval end; allocated=false is explicitly uncertain hour/shift allocation.';
COMMENT ON TABLE energy_meter_latest IS 'Independent latest real channel values and original event timestamps; no history scan or carried-forward fresh readings.';
COMMIT;
