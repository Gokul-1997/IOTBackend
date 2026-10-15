const db = require('../db');
const { getCurrentShift } = require('../utils/shift.util');

/*
 * Runs every hour (top of the hour).
 * Reads the PREVIOUS hour's production_hourly rows,
 * calculates OEE components, and upserts into oee_hourly.
 *
 * OEE formulas (using production_hourly as the source):
 *   planned_seconds  = shift duration minutes * 60  (from shifts table)
 *   availability     = run_seconds / planned_seconds
 *   performance      = produced_qty / (run_seconds / cycle_time_seconds)
 *   quality          = accepted_qty / produced_qty   (accepted = produced - reject - rework)
 *   oee              = availability * performance * quality
 *
 * Unknown is NULL, not 0. A machine with no cycle time has no knowable
 * performance, and an hour with nothing produced has no knowable quality —
 * writing 0 for either made oee 0 too, so the rollup reported a plant
 * running at 0% OEE while the OEE dashboard, computing from the same
 * production rows, reported 20%. AVG() skips NULLs, so an unmeasurable
 * machine no longer drags the factory average down; it is left out of it.
 */

let running = false;

/*
 * The previous IST clock hour. production_hourly rows start on IST hours
 * (10:00 IST = 04:30 UTC). This used UTC hours, so it read 04:00 UTC — a key
 * only the old runtime flush wrote, with no parts in it — and every
 * oee_hourly row had performance 0 and no quality or OEE.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
function previousIstHour(now) {
  const hourEnd = new Date(Math.floor((now.getTime() + IST_OFFSET_MS) / 3_600_000) * 3_600_000 - IST_OFFSET_MS);
  return { hourStart: new Date(hourEnd.getTime() - 3_600_000), hourEnd };
}

/* OEE for one IST hour, for every active company. The schedule passes the
   hour just ended; a back-fill passes older ones. */
async function runHourlyOee(hourStart) {

  try {
    // Iterate companies (shifts are company-scoped, not plant-scoped)
    const { rows: companies } = await db.query(
      `SELECT id FROM companies WHERE is_active = TRUE`
    );

    for (const company of companies) {
      const shift = await getCurrentShift(company.id, hourStart);
      if (!shift) continue;

      // FIX: hourly availability must use 3600s (1 hour), not full shift duration.
      const plannedSeconds = 3600;

      // Get production_hourly rows for this company's machines in this hour
      const { rows: prodRows } = await db.query(
        `SELECT
           ph.machine_id,
           COALESCE(ph.run_seconds, 0)  AS run_seconds,
           COALESCE(ph.produced_qty, 0) AS produced_qty,
           history.cycle_time_seconds
         FROM production_hourly ph
         JOIN machines m ON m.id = ph.machine_id AND m.company_id = $1
         LEFT JOIN LATERAL (
           SELECT CASE WHEN COUNT(*) = 1
                         AND MIN(j.started_at) <= ph.hour_start
                         AND MAX(COALESCE(j.ended_at, 'infinity'::timestamptz)) >= ph.hour_start + INTERVAL '1 hour'
                       THEN MAX(j.cycle_time_seconds) END AS cycle_time_seconds
             FROM machine_current_job j
            WHERE j.machine_id = ph.machine_id AND j.company_id = $1
              AND j.started_at < ph.hour_start + INTERVAL '1 hour'
              AND COALESCE(j.ended_at, 'infinity'::timestamptz) > ph.hour_start
         ) history ON TRUE
         WHERE ph.shift_id   = $2
           AND ph.hour_start = $3`,
        [company.id, shift.id, hourStart]
      );

      // Quality entries are cumulative shift totals, not measurements for an
      // individual hour. Query once for the shift, using its start date even
      // after midnight. Positive totals cannot be attributed to any one hour.
      const shiftDate = shiftStartDate(shift, hourStart);
      const { rows: qRows } = prodRows.length ? await db.query(
        `SELECT machine_id, COALESCE(SUM(reject_qty), 0) AS reject,
                COALESCE(SUM(rework_qty), 0) AS rework
           FROM quality_entries
          WHERE machine_id = ANY($1::int[]) AND shift_id = $2
            AND COALESCE(shift_date, (created_at AT TIME ZONE 'Asia/Kolkata')::date) = $3::date
          GROUP BY machine_id`,
        [prodRows.map(row => row.machine_id), shift.id, shiftDate]
      ) : { rows: [] };
      const qualityByMachine = new Map(qRows.map(row => [Number(row.machine_id), row]));
      const upserts = [];
      for (const row of prodRows) {
        const runSeconds       = Number(row.run_seconds);
        const producedQty      = Number(row.produced_qty);
        const cycleTimeSec     = Number(row.cycle_time_seconds);
        const multFactor       = Number(row.multiplication_factor || 1);

        // Availability: run / planned  (cap at 100)
        const availability = plannedSeconds > 0
          ? Math.min(100, (runSeconds / plannedSeconds) * 100)
          : 0;

        // Performance: actual / ideal output in run time  (cap at 100)
        // idealQty × multFactor = how many parts should have been made
        const idealQty = cycleTimeSec > 0 ? (runSeconds / cycleTimeSec) * multFactor : 0;
        const actualQty = producedQty * multFactor;
        // no cycle time, or no run time, means performance is unknown
        const performance = idealQty > 0
          ? Math.min(100, (actualQty / idealQty) * 100)
          : null;

        const shiftQuality = qualityByMachine.get(Number(row.machine_id));
        const quality = hourlyQuality(producedQty, Number(shiftQuality?.reject || 0), Number(shiftQuality?.rework || 0));

        /* OEE needs all three. With any factor unknown the product is
           unknown too — reporting 0 would claim the machine produced
           nothing of value, which is a different statement. */
        const oee = (performance === null || quality === null)
          ? null
          : (availability / 100) * (performance / 100) * (quality / 100) * 100;

        const round2 = v => (v === null ? null : Number(v.toFixed(2)));

        /* company_id is written now. It was left out, so the column was
           NULL on every row the job has ever produced, and any query
           filtering oee_hourly by company_id matched nothing. */
        upserts.push([
          row.machine_id, company.id, shift.id, hourStart,
          round2(availability), round2(performance), round2(quality), round2(oee)
        ]);
      }
      // Bounded bulk upserts keep the round trips independent of machine
      // count without exceeding Postgres's parameter limit for large fleets.
      for (let offset = 0; offset < upserts.length; offset += 1000) {
        const chunk = upserts.slice(offset, offset + 1000);
        const tuples = chunk.map((_, i) => `(${Array.from({ length: 8 }, (_, j) => '$' + (i * 8 + j + 1)).join(',')})`);
        await db.query(
          `INSERT INTO oee_hourly
             (machine_id, company_id, shift_id, hour_start, availability, performance, quality, oee)
           VALUES ${tuples.join(',')}
           ON CONFLICT (machine_id, hour_start) DO UPDATE SET
             company_id = EXCLUDED.company_id, shift_id = EXCLUDED.shift_id,
             availability = EXCLUDED.availability, performance = EXCLUDED.performance,
             quality = EXCLUDED.quality, oee = EXCLUDED.oee`, chunk.flat()
        );
      }
    }

    console.log('Hourly OEE calculated:', hourStart.toISOString());
  } catch (err) {
    console.error('hourlyOee.job error:', err.message);
    throw err;
  }
}

module.exports = async () => {
  if (running) {
    console.warn('[hourlyOee] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try { await runHourlyOee(previousIstHour(new Date()).hourStart); }
  catch { /* logged above */ }
  finally { running = false; }
};
module.exports.runHourlyOee = runHourlyOee;

module.exports.previousIstHour = previousIstHour;

/** An hour's quality cannot be inferred from positive cumulative shift
 * rejects. With none, the existing plant rule counts produced parts as good. */
function hourlyQuality(produced, shiftReject = 0, shiftRework = 0) {
  return produced > 0 && shiftReject === 0 && shiftRework === 0 ? 100 : null;
}
function shiftStartDate(shift, at) {
  const local = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  if (toMin(shift.start_time) > toMin(shift.end_time) && minute < toMin(shift.end_time)) {
    local.setUTCDate(local.getUTCDate() - 1);
  }
  return local.toISOString().slice(0, 10);
}
module.exports.hourlyQuality = hourlyQuality;
module.exports.shiftStartDate = shiftStartDate;
