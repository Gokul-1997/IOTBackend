-- Compact, incrementally maintained energy/electrical read models.
-- Requires 064's validated counter intervals. Historical data is not deleted.
-- WITH NO DATA keeps deployment bounded; backfill closed windows separately.
-- Real-time aggregates include the unmaterialized tail. Historical corrections
-- older than the refresh window require an explicit bounded refresh.
BEGIN;

DO $migration$
DECLARE
  has_timescale BOOLEAN := EXISTS (SELECT 1 FROM pg_extension WHERE extname='timescaledb');
  granularity TEXT;
  view_name TEXT;
  bucket_sql TEXT;
  select_sql TEXT;
  refresh_start INTERVAL;
  refresh_end INTERVAL;
  compress_after INTERVAL;
  metric TEXT;
  electrical_metrics TEXT := '';
BEGIN
  FOREACH granularity IN ARRAY ARRAY['hourly','daily','monthly'] LOOP
    view_name := 'energy_counter_' || granularity;
    IF has_timescale THEN
      bucket_sql := format('time_bucket(INTERVAL %L,observed_at,%L)',
        CASE granularity WHEN 'hourly' THEN '1 hour' WHEN 'daily' THEN '1 day' ELSE '1 month' END,
        'Asia/Kolkata');
    ELSE
      -- The same interface supports local PostgreSQL tests/development. These
      -- ordinary views do not provide TimescaleDB's production performance.
      bucket_sql := CASE granularity
        WHEN 'hourly' THEN 'date_bin(INTERVAL ''1 hour'',observed_at,TIMESTAMPTZ ''2000-01-01 00:00:00+05:30'')'
        WHEN 'daily' THEN 'date_bin(INTERVAL ''1 day'',observed_at,TIMESTAMPTZ ''2000-01-01 00:00:00+05:30'')'
        ELSE '(date_trunc(''month'',observed_at AT TIME ZONE ''Asia/Kolkata'') AT TIME ZONE ''Asia/Kolkata'')'
      END;
    END IF;

    select_sql := format($query$
      SELECT %s AS bucket,company_id,machine_id,register,shift_id,
             SUM(delta)::double precision AS kwh,
             COUNT(delta) AS accepted_intervals,
             COUNT(*) FILTER (WHERE quality NOT IN ('measured','flat','rollover')) AS rejected_intervals,
             SUM(delta) FILTER (WHERE NOT allocated)::double precision AS unallocated_kwh,
             COUNT(delta) FILTER (WHERE NOT allocated) AS unallocated_intervals,
             MIN(interval_start) AS first_interval_start,
             MAX(observed_at) AS last_observed_at,
             SUM(measured_seconds)::double precision AS measured_seconds
        FROM energy_counter_intervals
       GROUP BY 1,company_id,machine_id,register,shift_id
    $query$,bucket_sql);

    IF has_timescale THEN
      EXECUTE format('CREATE MATERIALIZED VIEW IF NOT EXISTS %I WITH (timescaledb.continuous,timescaledb.materialized_only=false,timescaledb.create_group_indexes=false) AS %s WITH NO DATA',view_name,select_sql);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(company_id,machine_id,register,bucket DESC,shift_id)',view_name || '_tenant_machine_time',view_name);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(company_id,register,bucket DESC,machine_id,shift_id)',view_name || '_tenant_fleet_time',view_name);
      -- The default materialization chunk is ten source chunks (70 days).
      -- Keep hourly/day chunks small enough for timely 30-day compression;
      -- monthly summaries use a larger, low-cardinality materialization.
      PERFORM set_chunk_time_interval(view_name::regclass,
        CASE WHEN granularity='monthly' THEN INTERVAL '120 days' ELSE INTERVAL '7 days' END);
      EXECUTE format('ALTER MATERIALIZED VIEW %I SET (timescaledb.compress=true,timescaledb.compress_segmentby=''company_id,machine_id,register'',timescaledb.compress_orderby=''bucket DESC'')',view_name);

      refresh_start := CASE WHEN granularity='monthly' THEN INTERVAL '3 months' ELSE INTERVAL '7 days' END;
      refresh_end := CASE WHEN granularity='hourly' THEN INTERVAL '1 minute' ELSE INTERVAL '1 hour' END;
      -- A monthly refresh must cover complete months. Compression is outside
      -- that window so a refresh never rewrites compressed materializations.
      compress_after := CASE WHEN granularity='monthly' THEN INTERVAL '120 days' ELSE INTERVAL '30 days' END;
      PERFORM add_continuous_aggregate_policy(view_name::regclass,
        start_offset=>refresh_start,end_offset=>refresh_end,
        schedule_interval=>INTERVAL '5 minutes',if_not_exists=>TRUE);
      PERFORM add_compression_policy(view_name::regclass,compress_after,
        schedule_interval=>INTERVAL '1 day',if_not_exists=>TRUE);
    ELSE
      EXECUTE format('CREATE OR REPLACE VIEW %I AS %s',view_name,select_sql);
    END IF;

    -- TimescaleDB exposes a continuous aggregate as a normal view over its
    -- internal materialization; COMMENT uses that actual PostgreSQL relkind.
    EXECUTE format('COMMENT ON VIEW %I IS %L',view_name,
      'Validated counter differences attributed to measurement end, grouped on Asia/Kolkata calendar boundaries. The kwh/unallocated_kwh aliases carry the register''s canonical unit (kWh, kVArh or kVAh). Unallocated differences cross an unknown gap or scope boundary; never interpolate them into billable intervals. NULL is unknown, not zero.');
  END LOOP;

  -- Preserve independent sample counts for sparse messages. Summing these
  -- sums/counts gives a correct sample mean; averaging bucket averages does not.
  FOREACH metric IN ARRAY ARRAY['kw_total','kva_total','i_avg','v_ll_avg','v_ln_avg','pf_avg','frequency_hz'] LOOP
    electrical_metrics := electrical_metrics || format(
      ',SUM(%I::double precision)::double precision AS %I,COUNT(%I) AS %I,MIN(%I)::double precision AS %I,MAX(%I)::double precision AS %I',
      metric,metric || '_sum',metric,metric || '_count',metric,metric || '_min',metric,metric || '_max');
  END LOOP;
  bucket_sql := CASE WHEN has_timescale
    THEN 'time_bucket(INTERVAL ''1 minute'',read_at,''Asia/Kolkata'')'
    ELSE 'date_bin(INTERVAL ''1 minute'',read_at,TIMESTAMPTZ ''2000-01-01 00:00:00+05:30'')' END;
  select_sql := format($query$
    SELECT %s AS bucket,company_id,machine_id,COUNT(*) AS samples,
           MIN(read_at) AS first_at,MAX(read_at) AS last_at%s,
           MAX(ABS(kw_total))::double precision AS kw_peak,
           MAX(GREATEST(i1,i2,i3))::double precision AS i_max,
           MIN(LEAST(v12,v23,v31))::double precision AS v_ll_min,
           MAX(GREATEST(v12,v23,v31))::double precision AS v_ll_max,
           MIN(LEAST(v1n,v2n,v3n))::double precision AS v_ln_min,
           MAX(GREATEST(v1n,v2n,v3n))::double precision AS v_ln_max
      FROM energy_meter_readings
     GROUP BY 1,company_id,machine_id
  $query$,bucket_sql,electrical_metrics);
  IF has_timescale THEN
    EXECUTE format('CREATE MATERIALIZED VIEW IF NOT EXISTS energy_electrical_1m WITH (timescaledb.continuous,timescaledb.materialized_only=false,timescaledb.create_group_indexes=false) AS %s WITH NO DATA',select_sql);
    CREATE INDEX IF NOT EXISTS energy_electrical_1m_tenant_machine_time ON energy_electrical_1m(company_id,machine_id,bucket DESC);
    CREATE INDEX IF NOT EXISTS energy_electrical_1m_tenant_fleet_time ON energy_electrical_1m(company_id,bucket DESC,machine_id);
    PERFORM set_chunk_time_interval('energy_electrical_1m',INTERVAL '7 days');
    ALTER MATERIALIZED VIEW energy_electrical_1m SET (timescaledb.compress=true,
      timescaledb.compress_segmentby='company_id,machine_id',timescaledb.compress_orderby='bucket DESC');
    PERFORM add_continuous_aggregate_policy('energy_electrical_1m',
      start_offset=>INTERVAL '7 days',end_offset=>INTERVAL '1 minute',
      schedule_interval=>INTERVAL '1 minute',if_not_exists=>TRUE);
    PERFORM add_compression_policy('energy_electrical_1m',INTERVAL '30 days',
      schedule_interval=>INTERVAL '1 day',if_not_exists=>TRUE);
  ELSE
    EXECUTE format('CREATE OR REPLACE VIEW energy_electrical_1m AS %s',select_sql);
  END IF;
  EXECUTE format('COMMENT ON VIEW energy_electrical_1m IS %L',
    'One-minute sparse electrical sample aggregates. Divide each metric sum by its own count; never carry missing fields forward as fresh observations. Phase extrema retain reported sign and supply anomalies. No estimated kWh is generated from these electrical samples.');
END
$migration$;

-- No retention policy: installation never deletes unarchived raw history.
COMMIT;
