const db = require('../db');

/* ─────────────────────────────────────────────────────────────
   META  –  machines + shifts for filter dropdowns
───────────────────────────────────────────────────────────── */
exports.getMeta = async (plantId) => {
  const [machinesRes, shiftsRes] = await Promise.all([
    db.query(`
      SELECT id, machine_serial_no
      FROM machines
      WHERE plant_id = $1 AND is_active = TRUE
      ORDER BY machine_serial_no
    `, [plantId]),
    db.query(`
      SELECT id, shift_code, shift_name, start_time, end_time
      FROM shifts
      WHERE plant_id = $1 AND is_active = TRUE
      ORDER BY start_time
    `, [plantId])
  ]);

  return {
    machines: machinesRes.rows,
    shifts:   shiftsRes.rows
  };
};

/* ─────────────────────────────────────────────────────────────
   CHART DATA
   Returns:
     machineOEE   – OEE metrics per machine for the selected date+shift
     hourlyCount  – hourly produced qty for the selected machine+shift+date
     totalProduced
───────────────────────────────────────────────────────────── */
exports.getChartData = async ({ plantId, machineId, shiftId, date }) => {

  /* ── Hourly part count (line chart) ── */
  let hourlyRows = [];

  if (machineId && shiftId && date) {
    // Use the shift's actual start/end times to compute the exact window.
    // For overnight shifts (start > end, e.g. 20:00–08:00):
    //   date=2026-03-21 → window is 2026-03-21 20:00 IST → 2026-03-22 08:00 IST
    // For day shifts (start <= end):
    //   date=2026-03-21 → window is 2026-03-21 08:00 IST → 2026-03-21 20:00 IST
    const hourlyRes = await db.query(`
      SELECT
        TO_CHAR(ph.hour_start AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS hour,
        SUM(ph.produced_qty)::int AS produced
      FROM production_hourly ph
      JOIN shifts s ON s.id = ph.shift_id
      WHERE ph.machine_id = $1
        AND ph.shift_id   = $2
        AND ph.hour_start >= ($3::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
        AND ph.hour_start <  (
              CASE WHEN s.start_time > s.end_time
                   THEN ($3::date + INTERVAL '1 day' + s.end_time)
                   ELSE ($3::date + s.end_time)
              END
            ) AT TIME ZONE 'Asia/Kolkata'
      GROUP BY ph.hour_start
      ORDER BY ph.hour_start
    `, [machineId, shiftId, date]);
    hourlyRows = hourlyRes.rows;
  } else if (machineId && date) {
    /* no shift selected — sum across all shifts for that date,
       but respect each shift's own window so night-shift carry-over
       from the previous day is NOT counted against this date.
       Each shift is scoped by its start/end on $3::date (same logic
       as the single-shift query above). */
    const hourlyRes = await db.query(`
      SELECT
        TO_CHAR(ph.hour_start AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS hour,
        SUM(ph.produced_qty)::int AS produced
      FROM production_hourly ph
      JOIN shifts s ON s.id = ph.shift_id
      JOIN machines m ON m.id = ph.machine_id
      WHERE m.plant_id    = $1
        AND ph.machine_id = $2
        AND s.plant_id    = $1
        AND s.is_active   = TRUE
        AND ph.hour_start >= ($3::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
        AND ph.hour_start <  (
              CASE WHEN s.start_time > s.end_time
                   THEN ($3::date + INTERVAL '1 day' + s.end_time)
                   ELSE ($3::date + s.end_time)
              END
            ) AT TIME ZONE 'Asia/Kolkata'
      GROUP BY ph.hour_start
      ORDER BY ph.hour_start
    `, [plantId, machineId, date]);
    hourlyRows = hourlyRes.rows;
  }

  const hourlyCount = hourlyRows.map(r => ({
    hour:     r.hour,
    produced: Number(r.produced || 0)
  }));

  /* ── Live parts_count from telemetry_raw (same source as dashboard) ──
     This matches the number shown on the dashboard card exactly,
     because it reads the actual machine counter (reset-adjusted). */
  let totalProduced = hourlyCount.reduce((s, r) => s + r.produced, 0);

  if (machineId && shiftId) {
    // Get shift start epoch for reset-offset calculation
    const { rows: shiftRows } = await db.query(`
      SELECT start_time, end_time,
        CASE WHEN start_time <= end_time
          THEN ($2::date + start_time) AT TIME ZONE 'Asia/Kolkata'
          ELSE (
            CASE WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time >= start_time
              THEN ($2::date + start_time) AT TIME ZONE 'Asia/Kolkata'
              ELSE (($2::date - INTERVAL '1 day') + start_time) AT TIME ZONE 'Asia/Kolkata'
            END
          )
        END AS shift_start
      FROM shifts WHERE id = $1
    `, [shiftId, date]);

    if (shiftRows[0]) {
      const shiftStartEpoch = Math.floor(new Date(shiftRows[0].shift_start).getTime() / 1000);

      const { rows: liveRows } = await db.query(`
        WITH first_count AS (
          SELECT parts_count AS first_parts
          FROM telemetry_raw
          WHERE machine_id = $1 AND received_at >= to_timestamp($2)
          ORDER BY received_at ASC LIMIT 1
        ),
        shift_raw AS (
          SELECT parts_count, received_at,
            LAG(parts_count) OVER (ORDER BY received_at) AS prev_count,
            GREATEST(
              COALESCE(LEAD(parts_count,1)  OVER (ORDER BY received_at),0),
              COALESCE(LEAD(parts_count,5)  OVER (ORDER BY received_at),0),
              COALESCE(LEAD(parts_count,10) OVER (ORDER BY received_at),0)
            ) AS max_future_10
          FROM telemetry_raw
          WHERE machine_id = $1 AND received_at >= to_timestamp($2)
        ),
        resets AS (
          SELECT COALESCE(SUM(prev_count),0) AS total_offset
          FROM shift_raw
          WHERE prev_count IS NOT NULL AND parts_count <= 2
            AND prev_count > 2 AND max_future_10 < (prev_count * 0.5)
        ),
        latest AS (
          SELECT parts_count FROM telemetry_raw
          WHERE machine_id = $1 ORDER BY received_at DESC LIMIT 1
        )
        SELECT GREATEST(0,
          l.parts_count + COALESCE(r.total_offset,0) - COALESCE(f.first_parts,0)
        ) AS adjusted
        FROM latest l, resets r, first_count f
      `, [machineId, shiftStartEpoch]);

      if (liveRows[0]) {
        totalProduced = Number(liveRows[0].adjusted);
      }
    }
  }

  return {
    hourlyCount,
    totalProduced
  };
};

/* ─────────────────────────────────────────────────────────────
   PER-PART TIMING
   For each part produced during the shift, returns:
     part_no     – part sequence number
     run_seconds – seconds machine was RUNNING while producing this part
     idle_seconds– seconds machine was IDLE before next part started
───────────────────────────────────────────────────────────── */
exports.getPartTiming = async ({ machineId, shiftStartEpoch }) => {

  if (!machineId || !shiftStartEpoch) return [];

  const res = await db.query(`
    WITH ordered AS (
      SELECT
        parts_count,
        machine_status,
        received_at,
        LAG(parts_count) OVER (ORDER BY received_at)  AS prev_parts,
        LAG(received_at) OVER (ORDER BY received_at)  AS prev_time,
        EXTRACT(EPOCH FROM (
          received_at - LAG(received_at) OVER (ORDER BY received_at)
        ))::int AS interval_sec
      FROM telemetry_raw
      WHERE machine_id  = $1
        AND received_at >= to_timestamp($2)
    ),
    part_events AS (
      -- Row where parts_count just incremented = part completed.
      -- started_at = previous part's completed_at.
      -- For the very first part, fall back to shift start (to_timestamp($2)).
      SELECT
        ROW_NUMBER() OVER (ORDER BY received_at)                              AS part_no,
        received_at                                                           AS completed_at,
        COALESCE(
          LAG(received_at) OVER (ORDER BY received_at),
          to_timestamp($2)
        )                                                                     AS started_at
      FROM ordered
      WHERE prev_parts IS NOT NULL
        AND parts_count > prev_parts
        AND parts_count > 0
    )
    SELECT
      pe.part_no,
      GREATEST(0, SUM(
        CASE WHEN UPPER(o.machine_status) IN ('RUN','RUNNING','CUTTING')
             THEN COALESCE(o.interval_sec, 0) ELSE 0 END
      ))::int AS run_seconds,
      GREATEST(0, SUM(
        CASE WHEN UPPER(o.machine_status) NOT IN ('RUN','RUNNING','CUTTING')
             THEN COALESCE(o.interval_sec, 0) ELSE 0 END
      ))::int AS idle_seconds
    FROM part_events pe
    JOIN ordered o
      ON o.received_at >  pe.started_at
     AND o.received_at <= pe.completed_at
    GROUP BY pe.part_no, pe.started_at
    ORDER BY pe.started_at
  `, [machineId, shiftStartEpoch]);

  return res.rows.map(r => ({
    part_no:  Number(r.part_no),
    run_min:  +(Number(r.run_seconds)  / 60).toFixed(1),
    idle_min: +(Number(r.idle_seconds) / 60).toFixed(1)
  }));
};
