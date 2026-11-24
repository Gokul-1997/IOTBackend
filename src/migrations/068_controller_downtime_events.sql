-- Resolve machine-side reason codes through the company's existing catalogue.
-- Record only observed stopped intervals; zero is the controller's clear signal.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS controller_reason_code TEXT;

CREATE TABLE IF NOT EXISTS controller_downtime_state (
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  machine_id INT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  stopped BOOLEAN NOT NULL,
  reason_id INT REFERENCES downtime_reasons(id) ON DELETE SET NULL,
  reason_code TEXT,
  shift_id INT REFERENCES shifts(id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES downtime_events(id) ON DELETE SET NULL,
  PRIMARY KEY(company_id,machine_id)
);

CREATE OR REPLACE FUNCTION controller_downtime_observe(
  tenant INT, device INT, point TIMESTAMPTZ, arrival TIMESTAMPTZ,
  machine_state TEXT, raw_value DOUBLE PRECISION
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE previous controller_downtime_state%ROWTYPE;
  signal_code TEXT; reason INT; shift INT; stopped_now BOOLEAN;
  interval_end TIMESTAMPTZ; event BIGINT; local_time TIME;
BEGIN
  IF tenant IS NULL OR device IS NULL OR point IS NULL OR arrival IS NULL
    OR point>arrival+INTERVAL '60 seconds'
    OR NOT EXISTS(SELECT 1 FROM machines WHERE id=device AND company_id=tenant) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('controller-downtime:'||tenant||':'||device,0));
  stopped_now:=UPPER(COALESCE(machine_state,'')) IN ('IDLE','STOP','ALARM','EMERGENCY');
  IF raw_value>0 AND raw_value<'Infinity'::float8 AND raw_value=TRUNC(raw_value)
    AND raw_value<=9007199254740991 THEN
    signal_code:=raw_value::bigint::text;
    SELECT id INTO reason FROM downtime_reasons
      WHERE is_active AND (company_id=tenant OR company_id IS NULL) AND BTRIM(downtime_reasons.code)=signal_code
      ORDER BY company_id IS NULL,id LIMIT 1;
  END IF;
  local_time:=(point AT TIME ZONE 'Asia/Kolkata')::time;
  SELECT s.id INTO shift FROM shifts s JOIN machine_shift_config c ON c.shift_id=s.id
    WHERE c.machine_id=device AND s.company_id=tenant AND s.is_active
      AND CASE WHEN s.start_time<s.end_time THEN local_time>=s.start_time AND local_time<s.end_time
        WHEN s.start_time>s.end_time THEN local_time>=s.start_time OR local_time<s.end_time
        ELSE TRUE END
    ORDER BY s.id LIMIT 1;
  SELECT * INTO previous FROM controller_downtime_state WHERE company_id=tenant AND machine_id=device FOR UPDATE;
  IF FOUND THEN
    IF point<previous.observed_at OR (point=previous.observed_at AND arrival<previous.received_at) THEN RETURN; END IF;
    IF point>previous.observed_at AND previous.stopped AND previous.reason_id IS NOT NULL THEN
      interval_end:=LEAST(point,previous.observed_at+INTERVAL '60 seconds');
      -- Operator-entered intervals take precedence; never modify or double-count them.
      IF NOT EXISTS(SELECT 1 FROM downtime_events
        WHERE company_id=tenant AND machine_id=device AND source<>'controller'
          AND started_at<interval_end AND COALESCE(ended_at,'Infinity'::timestamptz)>previous.observed_at) THEN
        IF previous.event_id IS NOT NULL THEN
          UPDATE downtime_events SET ended_at=interval_end
            WHERE id=previous.event_id AND company_id=tenant AND machine_id=device
              AND source='controller' AND downtime_reason_id=previous.reason_id
              AND shift_id IS NOT DISTINCT FROM previous.shift_id AND ended_at=previous.observed_at
            RETURNING id INTO event;
        END IF;
        IF event IS NULL THEN
          INSERT INTO downtime_events(company_id,machine_id,shift_id,downtime_reason_id,
            started_at,ended_at,source,controller_reason_code,notes)
          VALUES(tenant,device,previous.shift_id,previous.reason_id,previous.observed_at,interval_end,
            'controller',previous.reason_code,'Machine-reported reason code '||previous.reason_code)
          RETURNING id INTO event;
        END IF;
      END IF;
    END IF;
    IF NOT stopped_now OR reason IS DISTINCT FROM previous.reason_id
      OR shift IS DISTINCT FROM previous.shift_id OR point>previous.observed_at+INTERVAL '60 seconds' THEN event:=NULL; END IF;
    IF point=previous.observed_at AND stopped_now AND reason=previous.reason_id
      AND shift IS NOT DISTINCT FROM previous.shift_id THEN event:=previous.event_id; END IF;
  END IF;
  INSERT INTO controller_downtime_state(company_id,machine_id,observed_at,received_at,stopped,reason_id,reason_code,shift_id,event_id)
    VALUES(tenant,device,point,arrival,stopped_now,reason,signal_code,shift,event)
    ON CONFLICT(company_id,machine_id) DO UPDATE SET observed_at=EXCLUDED.observed_at,received_at=EXCLUDED.received_at,
      stopped=EXCLUDED.stopped,reason_id=EXCLUDED.reason_id,reason_code=EXCLUDED.reason_code,
      shift_id=EXCLUDED.shift_id,event_id=EXCLUDED.event_id;
END $$;

CREATE OR REPLACE FUNCTION controller_downtime_from_telemetry() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.device_time IS NOT NULL THEN
    PERFORM controller_downtime_observe(NEW.company_id,NEW.machine_id,to_timestamp(NEW.device_time),
      NEW.received_at,NEW.machine_status,NEW.controller_downtime_value);
  END IF;
  RETURN NEW;
END $$;

-- Pin privileged functions to the migration's schema, including isolated tests.
DO $$ DECLARE target TEXT:=current_schema(); BEGIN
  EXECUTE format('ALTER FUNCTION controller_downtime_observe(INT,INT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,DOUBLE PRECISION) SET search_path=pg_catalog,%I',target);
  EXECUTE format('ALTER FUNCTION controller_downtime_from_telemetry() SET search_path=pg_catalog,%I',target);
END $$;
REVOKE ALL ON FUNCTION controller_downtime_observe(INT,INT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,DOUBLE PRECISION) FROM PUBLIC;
REVOKE ALL ON FUNCTION controller_downtime_from_telemetry() FROM PUBLIC;
DROP TRIGGER IF EXISTS controller_downtime_from_telemetry ON telemetry_raw;
CREATE TRIGGER controller_downtime_from_telemetry AFTER INSERT ON telemetry_raw
  FOR EACH ROW EXECUTE FUNCTION controller_downtime_from_telemetry();
COMMIT;
