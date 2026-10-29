-- Independent energy messages share the machine topic without becoming CNC
-- observations. Nullable measurements retain exactly the supplied fields.
BEGIN;
ALTER TABLE energy_meter_readings ADD COLUMN IF NOT EXISTS standalone BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE energy_meter_readings ADD COLUMN IF NOT EXISTS standalone_fields TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_energy_meter_standalone_company_machine_time
  ON energy_meter_readings(company_id,machine_id,read_at DESC) WHERE standalone;

-- Old full telemetry remains the source for unsampled readings. A standalone
-- meter observation replaces only its own scalar fields at the same device
-- second; the other raw fields remain independent observations. This avoids
-- counting the same counter twice when firmware sends both formats.
CREATE OR REPLACE VIEW energy_observations AS
SELECT t.machine_id,t.company_id,t.received_at,
       CASE WHEN r.kwh_total IS NULL THEN t.energy END AS energy,
       CASE WHEN r.v_ll_avg IS NULL THEN t.voltage END AS voltage,
       CASE WHEN r.i_avg IS NULL THEN t.current END AS current,
       CASE WHEN r.kw_total IS NULL THEN t.power END AS power,
       COALESCE(to_timestamp(t.device_time),t.received_at) AS observed_at,FALSE AS standalone
FROM telemetry_raw t
LEFT JOIN energy_meter_readings r
  ON r.machine_id=t.machine_id AND r.company_id=t.company_id
 AND r.standalone AND r.read_at=to_timestamp(t.device_time)
UNION ALL
SELECT machine_id,company_id,read_at AS received_at,
       kwh_total AS energy,v_ll_avg AS voltage,i_avg AS current,kw_total AS power,read_at AS observed_at,TRUE AS standalone
FROM energy_meter_readings WHERE standalone;
COMMENT ON VIEW energy_observations IS 'Canonical electrical observations only; never use for CNC liveness, runtime, alarms or parts. Query with explicit tenant and bounded time predicates.';

DO $$
DECLARE measurement_columns TEXT;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='machine_api_user') THEN
  SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position)
    INTO measurement_columns FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='energy_meter_readings'
     AND column_name NOT IN ('machine_id','company_id','read_at','received_at');
  EXECUTE 'GRANT UPDATE ('||measurement_columns||') ON energy_meter_readings TO machine_api_user';
  GRANT SELECT ON energy_observations TO machine_api_user;
 END IF;
END $$;
COMMIT;
