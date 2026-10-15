const db = require('../db');
const historical = require('../lib/historical-production');

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

/*
 * Compute every completed shift instance whose end falls in [fromMs, toMs].
 * The schedule passes the last 48 hours; a back-fill (scripts/
 * fix-hourly-double-count.js) passes a longer range.
 */
async function runShiftOee({ fromMs, toMs }) {

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
      // that ended within the range.
      const shiftInstances = expandShiftInstances(shifts, { fromMs, toMs });

      const { rows: machines } = await db.query(
        `SELECT id FROM machines WHERE company_id = $1 AND is_active = TRUE`,
        [company.id]
      );
      const machineIds = machines.map(m => m.id);
      if (machineIds.length === 0) continue;

      const done = [];
      for (const inst of shiftInstances) {
        const { shift, shiftDate } = inst;
        const shiftDurationMinutes = getShiftDurationMinutes(shift);
        const plannedSeconds = shiftDurationMinutes * 60;

        // Historical snapshots, including partial clock-hour shift buckets.
        const { rows: observedHours } = await db.query(historical.rowsSQL, [company.id, machineIds, shift.id, shiftDate]);
        const byMachine = new Map();
        for (const hour of observedHours) {
          if (!byMachine.has(hour.machine_id)) byMachine.set(hour.machine_id, []);
          byMachine.get(hour.machine_id).push(hour);
        }

        const { rows: allQRows } = await db.query(
          `SELECT
             machine_id,
             COALESCE(SUM(reject_qty), 0) AS reject,
             COALESCE(SUM(rework_qty), 0) AS rework
           FROM quality_entries
           WHERE machine_id = ANY($1)
             AND shift_id   = $2
             AND COALESCE(shift_date, (created_at AT TIME ZONE 'Asia/Kolkata')::date) = $3::date
           GROUP BY machine_id`,
          [machineIds, shift.id, shiftDate]
        );

        const qualityMap = {};
        for (const q of allQRows) qualityMap[q.machine_id] = q;

        const upsertValues = [];
        const upsertParams = [];
        let   paramIdx     = 1;

        for (const [machineId, hours] of byMachine) {

          const totalQty = hours.reduce((sum, row) => sum + Number(row.produced_qty || 0), 0);
          const q = qualityMap[machineId] || {};
          const accepted = Math.max(0, totalQty - Number(q.reject || 0) - Number(q.rework || 0));
          const { availability, performance, quality, oee } = historical.metrics(hours, plannedSeconds, accepted);

          upsertValues.push(
            `($${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++},$${paramIdx++})`
          );
          upsertParams.push(machineId, shift.id, shiftDate, availability, performance, quality, oee, company.id);
        }

        if (upsertValues.length > 0) {
          await db.query(
            `INSERT INTO oee_shift_summary
               (machine_id, shift_id, shift_date, availability, performance, quality, oee, company_id)
             VALUES ${upsertValues.join(',')}
             ON CONFLICT (machine_id, shift_id, shift_date)
             DO UPDATE SET
               company_id = EXCLUDED.company_id,
               availability = EXCLUDED.availability,
               performance  = EXCLUDED.performance,
               quality      = EXCLUDED.quality,
               oee          = EXCLUDED.oee`,
            upsertParams
          );
          done.push(`${shift.shift_code} started ${shiftDate} (${upsertValues.length} machines)`);
        }
      }
      /* One line per company per run. The same completed shifts come round
         every 10 minutes for 48 hours on purpose — readings that arrive late
         and corrections reach the shift figures — and the date is the day a
         shift STARTED, so a night shift from the 5th to the 6th reads "5th".
         A line per shift per run made that look like a fault. */
      if (done.length) {
        const hours = Math.round((toMs - fromMs) / 3_600_000);
        console.log(`[shiftOee] company ${company.id}: recomputed ${done.length} completed shift(s) that ended in the last ${hours} h — ${done.join('; ')}`);
      }
    }
  } catch (err) {
    console.error('shiftOee.job error:', err.message);
    console.error(err.stack);
    throw err;
  }
}

module.exports = async () => {
  if (running) {
    console.warn('[shiftOee] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    const now = Date.now();
    await runShiftOee({ fromMs: now - BACKFILL_HOURS * 3600 * 1000, toMs: now });
  } catch { /* logged above */ }
  finally { running = false; }
};
module.exports.runShiftOee = runShiftOee;

/*
 * For each shift, list every completed instance (shiftDate + window) whose end
 * time falls within the last `backfillHours`. Handles overnight shifts.
 * windowStart/windowEnd are JS Dates in UTC; shiftDate is 'YYYY-MM-DD' in IST.
 */
function expandShiftInstances(shifts, { fromMs, toMs }) {
  const out = [];
  const nowMs = Math.min(Date.now(), toMs);
  const cutoffMs = fromMs;
  const days = Math.ceil((Date.now() - fromMs) / 86_400_000);

  // Walk back day-by-day in IST
  for (let i = 0; i <= days + 1; i++) {
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
