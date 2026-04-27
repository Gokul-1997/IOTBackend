const db = require('../db');

/*
 * Runs every 10 minutes.
 * Backfills oee_shift_summary for all completed shifts in the last 48 hours.
 * Upsert is idempotent, so re-running is safe — late-arriving production_hourly
 * data gets picked up on the next tick instead of being lost forever.
 *
 * Per-shift filter uses the shift's actual start/end window (handling overnight
 * shifts that cross midnight) instead of a single-date filter that loses half
 * the data on night shifts.
 */

let running = false;

const BACKFILL_HOURS = 48;

module.exports = async () => {
  if (running) {
    console.warn('[shiftOee] previous run still in progress — skipping this tick');
    return;
  }
  running = true;

  try {
    const { rows: companies } = await db.query(
      `SELECT id FROM companies WHERE is_active = TRUE`
    );

    for (const company of companies) {
      // All active shifts for this company
      const { rows: shifts } = await db.query(
        `SELECT * FROM shifts WHERE company_id = $1 AND is_active = TRUE`,
        [company.id]
      );

      // Build (shift, shiftDate) pairs for every completed shift instance
      // that ended within the last BACKFILL_HOURS.
      const shiftInstances = expandShiftInstances(shifts, BACKFILL_HOURS);

      const { rows: machines } = await db.query(
        `SELECT id FROM machines WHERE company_id = $1 AND is_active = TRUE`,
        [company.id]
      );
      const machineIds = machines.map(m => m.id);
      if (machineIds.length === 0) continue;

      for (const inst of shiftInstances) {
        const { shift, shiftDate, windowStart, windowEnd } = inst;
        const shiftDurationMinutes = getShiftDurationMinutes(shift);
        const plannedSeconds = shiftDurationMinutes * 60;

        // Production totals scoped by exact shift window — works for overnight shifts.
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
             AND ph.hour_start >= $3
             AND ph.hour_start <  $4
           GROUP BY ph.machine_id, c.cycle_time`,
          [machineIds, shift.id, windowStart, windowEnd]
        );

        const { rows: allQRows } = await db.query(
          `SELECT
             machine_id,
             COALESCE(SUM(reject_qty), 0) AS reject,
             COALESCE(SUM(rework_qty), 0) AS rework
           FROM quality_entries
           WHERE machine_id = ANY($1)
             AND shift_id   = $2
             AND created_at >= $3
             AND created_at <  $4
           GROUP BY machine_id`,
          [machineIds, shift.id, windowStart, windowEnd]
        );

        const qualityMap = {};
        for (const q of allQRows) qualityMap[q.machine_id] = q;

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
          console.log(`[shiftOee] upserted ${upsertValues.length} rows: company=${company.id} shift=${shift.shift_code} date=${shiftDate}`);
        }
      }
    }
  } catch (err) {
    console.error('shiftOee.job error:', err.message);
    console.error(err.stack);
  } finally {
    running = false;
  }
};

/*
 * For each shift, list every completed instance (shiftDate + window) whose end
 * time falls within the last `backfillHours`. Handles overnight shifts.
 * windowStart/windowEnd are JS Dates in UTC; shiftDate is 'YYYY-MM-DD' in IST.
 */
function expandShiftInstances(shifts, backfillHours) {
  const out = [];
  const nowMs = Date.now();
  const cutoffMs = nowMs - backfillHours * 3600 * 1000;

  // Walk back day-by-day in IST
  for (let i = 0; i <= Math.ceil(backfillHours / 24) + 1; i++) {
    const dayIST = istDateOffset(-i); // 'YYYY-MM-DD'

    for (const shift of shifts) {
      const [sh, sm] = shift.start_time.split(':').map(Number);
      const [eh, em] = shift.end_time.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin   = eh * 60 + em;
      const overnight = startMin > endMin;

      const windowStart = new Date(`${dayIST}T${pad2(sh)}:${pad2(sm)}:00+05:30`);
      const endDay = overnight ? istDateOffset(1, dayIST) : dayIST;
      const windowEnd = new Date(`${endDay}T${pad2(eh)}:${pad2(em)}:00+05:30`);

      // Skip future or not-yet-ended shifts
      if (windowEnd.getTime() > nowMs) continue;
      // Skip shifts ended before our backfill window
      if (windowEnd.getTime() < cutoffMs) continue;

      out.push({
        shift,
        shiftDate: dayIST,
        windowStart,
        windowEnd
      });
    }
  }
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Returns IST date YYYY-MM-DD offset by `days` from baseIstDate (or today IST).
function istDateOffset(days, baseIstDate) {
  let base;
  if (baseIstDate) {
    const [y, m, d] = baseIstDate.split('-').map(Number);
    base = new Date(Date.UTC(y, m - 1, d));
  } else {
    // today in IST
    const nowMs = Date.now();
    const istMs = nowMs + 5.5 * 3600 * 1000;
    const istDate = new Date(istMs);
    base = new Date(Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()));
  }
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

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
