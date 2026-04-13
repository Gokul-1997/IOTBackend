const db = require('../db');

/* ─────────────────────────────────────────────────────────────
   META  –  machines + shifts for filter dropdowns
───────────────────────────────────────────────────────────── */
exports.getMeta = async (plantId, companyId) => {
  const [machinesRes, shiftsRes] = await Promise.all([
    db.query(`
      SELECT id, machine_serial_no
      FROM machines
      WHERE company_id = $1 AND is_active = TRUE
      ORDER BY machine_serial_no
    `, [companyId]),
    db.query(`
      SELECT id, shift_code, shift_name, start_time, end_time
      FROM shifts
      WHERE company_id = $1 AND is_active = TRUE
      ORDER BY start_time
    `, [companyId])
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
exports.getChartData = async ({ plantId, companyId, machineId, shiftId, date }) => {

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
      WHERE m.company_id  = $1
        AND ph.machine_id = $2
        AND s.company_id  = $1
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
    `, [companyId, machineId, date]);
    hourlyRows = hourlyRes.rows;
  }

  const hourlyCount = hourlyRows.map(r => ({
    hour:     r.hour,
    produced: Number(r.produced || 0)
  }));

  // totalProduced = sum of production_hourly buckets — same source as the hourly bar chart.
  // Both numbers on the page now come from the same table, so they are always consistent.
  const totalProduced = hourlyCount.reduce((s, r) => s + r.produced, 0);

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
exports.getPartTiming = async ({ machineId, shiftStartEpoch, shiftEndEpoch, maxParts }) => {

  if (!machineId || !shiftStartEpoch) return [];

  // Cap end at now for live shifts; if no end provided default to now
  const effectiveEnd = shiftEndEpoch
    ? Math.min(Number(shiftEndEpoch), Math.floor(Date.now() / 1000))
    : Math.floor(Date.now() / 1000);

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
        AND received_at <  to_timestamp($3)
    ),
    part_events AS (
      -- Each row where parts_count incremented = one telemetry event.
      -- increment = how many parts were actually produced in this interval
      -- (can be > 1 when telemetry has a gap and the counter jumped).
      SELECT
        received_at                                                           AS completed_at,
        COALESCE(
          LAG(received_at) OVER (ORDER BY received_at),
          to_timestamp($2)
        )                                                                     AS started_at,
        (parts_count - prev_parts)                                            AS increment
      FROM ordered
      WHERE prev_parts IS NOT NULL
        AND parts_count > prev_parts
        AND parts_count > 0
    )
    SELECT
      pe.completed_at,
      pe.started_at,
      pe.increment,
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
    GROUP BY pe.completed_at, pe.started_at, pe.increment
    ORDER BY pe.started_at
  `, [machineId, shiftStartEpoch, effectiveEnd]);

  // Expand multi-part jumps: if parts_count jumped by N in one interval,
  // split run/idle time equally across N parts.
  const parts = [];
  let partNo = 1;
  for (const r of res.rows) {
    const increment  = Math.max(1, Number(r.increment));
    const runSec     = Number(r.run_seconds);
    const idleSec    = Number(r.idle_seconds);
    const runPerPart  = runSec  / increment;
    const idlePerPart = idleSec / increment;

    for (let i = 0; i < increment; i++) {
      parts.push({
        part_no:  partNo++,
        run_min:  +(runPerPart  / 60).toFixed(1),
        idle_min: +(idlePerPart / 60).toFixed(1)
      });
    }
  }
  return maxParts ? parts.slice(0, maxParts) : parts;
};
