const db = require('../db');

/*
 * Runs every 10 minutes.
 * When a shift has just ended, rolls up production_hourly + quality_entries
 * into oee_shift_summary.
 *
 * FIX: previously used AVG(oee_hourly.availability/performance/quality/oee),
 * which gives mathematically incorrect results (simple average of percentages).
 * Now computes OEE from raw totals in production_hourly + quality_entries.
 */

let running = false;

module.exports = async () => {
  if (running) {
    console.warn('[shiftOee] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  const now = new Date();

  try {
    // Iterate companies (shifts are company-scoped, not plant-scoped)
    const { rows: companies } = await db.query(
      `SELECT id FROM companies WHERE is_active = TRUE`
    );

    for (const company of companies) {
      // Find shifts that ended within the last 10 minutes
      const { rows: endedShifts } = await db.query(
        `SELECT s.*
         FROM shifts s
         WHERE s.company_id = $1
           AND s.is_active = TRUE
           AND (
             (s.start_time < s.end_time
               AND (NOW() AT TIME ZONE 'Asia/Kolkata')::time
                 BETWEEN s.end_time AND (s.end_time + INTERVAL '10 minutes')::time)
             OR
             (s.start_time > s.end_time
               AND (NOW() AT TIME ZONE 'Asia/Kolkata')::time
                 BETWEEN s.end_time AND (s.end_time + INTERVAL '10 minutes')::time)
           )`,
        [company.id]
      );

      for (const shift of endedShifts) {
        // Determine the shift date (yesterday if overnight shift ended this morning)
        const nowIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const [eh, em] = shift.end_time.split(':').map(Number);
        const endMin = eh * 60 + em;
        const [sh, sm] = shift.start_time.split(':').map(Number);
        const startMin = sh * 60 + sm;

        let shiftDate;
        if (startMin > endMin) {
          // Overnight: shift started yesterday
          const yesterday = new Date(nowIST);
          yesterday.setDate(yesterday.getDate() - 1);
          shiftDate = yesterday.toISOString().split('T')[0];
        } else {
          shiftDate = nowIST.toISOString().split('T')[0];
        }

        // Full shift planned seconds (for availability denominator)
        const shiftDurationMinutes = getShiftDurationMinutes(shift);
        const plannedSeconds = shiftDurationMinutes * 60;

        // Get all machines for this company
        const { rows: machines } = await db.query(
          `SELECT id FROM machines WHERE company_id = $1 AND is_active = TRUE`,
          [company.id]
        );

        const machineIds = machines.map(m => m.id);

        // Batch query: production totals for all machines in one round-trip
        const { rows: allProdRows } = await db.query(
          `SELECT
             ph.machine_id,
             SUM(ph.run_seconds)::int  AS total_run_seconds,
             SUM(ph.produced_qty)::int AS total_produced_qty,
             EXTRACT(EPOCH FROM COALESCE(c.cycle_time, '0 seconds'))::int AS cycle_time_seconds
           FROM production_hourly ph
           LEFT JOIN machine_current_job mcj
             ON mcj.machine_id = ph.machine_id AND mcj.is_active = TRUE
           LEFT JOIN components c ON c.id = mcj.component_id
           WHERE ph.machine_id = ANY($1)
             AND ph.shift_id   = $2
             AND ph.hour_start::date = $3::date
           GROUP BY ph.machine_id, c.cycle_time`,
          [machineIds, shift.id, shiftDate]
        );

        // Batch query: quality totals for all machines in one round-trip
        const { rows: allQRows } = await db.query(
          `SELECT
             machine_id,
             COALESCE(SUM(reject_qty), 0) AS reject,
             COALESCE(SUM(rework_qty), 0) AS rework
           FROM quality_entries
           WHERE machine_id = ANY($1)
             AND shift_id   = $2
             AND created_at::date = $3::date
           GROUP BY machine_id`,
          [machineIds, shift.id, shiftDate]
        );

        const qualityMap = {};
        for (const q of allQRows) qualityMap[q.machine_id] = q;

        // Build upsert values for all machines in one query
        const upsertValues = [];
        const upsertParams = [];
        let   paramIdx     = 1;

        for (const prod of allProdRows) {
          if (prod.total_run_seconds === null) continue;

          const totalRun     = Number(prod.total_run_seconds || 0);
          const totalQty     = Number(prod.total_produced_qty || 0);
          const cycleTimeSec = Number(prod.cycle_time_seconds || 0);
          const q            = qualityMap[prod.machine_id] || {};
          const reject       = Number(q.reject || 0);
          const rework       = Number(q.rework || 0);
          const accepted     = Math.max(0, totalQty - reject - rework);

          const availability = plannedSeconds > 0
            ? Math.min(100, (totalRun / plannedSeconds) * 100) : 0;
          const idealQty     = cycleTimeSec > 0 ? totalRun / cycleTimeSec : 0;
          const performance  = idealQty > 0
            ? Math.min(100, (totalQty / idealQty) * 100) : 0;
          const quality      = totalQty > 0
            ? Math.min(100, (accepted / totalQty) * 100) : 0;
          const oee          = (availability / 100) * (performance / 100) * (quality / 100) * 100;

          upsertValues.push(
            `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`
          );
          upsertParams.push(
            prod.machine_id, shift.id, shiftDate,
            Number(availability.toFixed(2)),
            Number(performance.toFixed(2)),
            Number(quality.toFixed(2)),
            Number(oee.toFixed(2))
          );
        }

        if (upsertValues.length > 0) {
          await db.query(
            `INSERT INTO oee_shift_summary
               (machine_id, shift_id, shift_date, availability, performance, quality, oee)
             VALUES ${upsertValues.join(',')}
             ON CONFLICT (machine_id, shift_id, shift_date)
             DO UPDATE SET
               availability = EXCLUDED.availability,
               performance  = EXCLUDED.performance,
               quality      = EXCLUDED.quality,
               oee          = EXCLUDED.oee`,
            upsertParams
          );
        }

        console.log(`Shift OEE rollup done: company=${company.id} shift=${shift.shift_code} date=${shiftDate}`);
      }
    }
  } catch (err) {
    console.error('shiftOee.job error:', err.message);
  } finally {
    running = false;
  }
};

// Helper: shift duration in minutes (handles overnight shifts)
function getShiftDurationMinutes(shift) {
  const [sh, sm] = shift.start_time.split(':').map(Number);
  const [eh, em] = shift.end_time.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  const duration = endMin > startMin
    ? endMin - startMin
    : (1440 - startMin) + endMin;
  return Math.max(1, duration - Number(shift.break_minutes || 0));
}
