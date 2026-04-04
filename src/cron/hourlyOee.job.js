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
 * Note: performance uses cycle_time from components via machine_current_job.
 *       If no cycle_time is set, performance defaults to 0.
 */

module.exports = async () => {
  const now = new Date();

  // Previous hour window — use UTC methods so the IST +5:30 offset
  // doesn't cause a :30 misalignment against production_hourly timestamps.
  const hourEnd   = new Date(now);
  hourEnd.setUTCMinutes(0, 0, 0);

  const hourStart = new Date(hourEnd);
  hourStart.setUTCHours(hourEnd.getUTCHours() - 1);

  try {
    const { rows: plants } = await db.query(
      `SELECT id FROM plants WHERE is_active = TRUE`
    );

    for (const plant of plants) {
      const shift = await getCurrentShift(plant.id, hourStart);
      if (!shift) continue;

      // FIX: hourly availability must use 3600s (1 hour), not full shift duration.
      // Full shift duration (e.g. 28800s for 8h) caused max availability of 12.5% per hour.
      const plannedSeconds = 3600;

      // Get production_hourly rows for this plant's machines in this hour
      const { rows: prodRows } = await db.query(
        `SELECT
           ph.machine_id,
           COALESCE(ph.run_seconds, 0)  AS run_seconds,
           COALESCE(ph.produced_qty, 0) AS produced_qty,
           EXTRACT(EPOCH FROM COALESCE(c.cycle_time, '0'))::int AS cycle_time_seconds
         FROM production_hourly ph
         JOIN machines m ON m.id = ph.machine_id AND m.plant_id = $1
         LEFT JOIN machine_current_job mcj
           ON mcj.machine_id = ph.machine_id AND mcj.is_active = TRUE
         LEFT JOIN components c ON c.id = mcj.component_id
         WHERE ph.shift_id   = $2
           AND ph.hour_start = $3`,
        [plant.id, shift.id, hourStart]
      );

      for (const row of prodRows) {
        const runSeconds    = Number(row.run_seconds);
        const producedQty   = Number(row.produced_qty);
        const cycleTimeSec  = Number(row.cycle_time_seconds);

        // Availability: run / planned  (cap at 100)
        const availability = plannedSeconds > 0
          ? Math.min(100, (runSeconds / plannedSeconds) * 100)
          : 0;

        // Performance: actual / ideal output in run time  (cap at 100)
        const idealQty = cycleTimeSec > 0 ? runSeconds / cycleTimeSec : 0;
        const performance = idealQty > 0
          ? Math.min(100, (producedQty / idealQty) * 100)
          : 0;

        // Quality: accepted / produced
        // Fetch reject + rework for this machine, shift, this hour's date
        const { rows: qRows } = await db.query(
          `SELECT
             COALESCE(SUM(reject_qty), 0) AS reject,
             COALESCE(SUM(rework_qty), 0) AS rework
           FROM quality_entries
           WHERE machine_id = $1
             AND shift_id   = $2
             AND created_at::date = $3::date`,
          [row.machine_id, shift.id, hourStart]
        );

        const reject   = Number(qRows[0].reject);
        const rework   = Number(qRows[0].rework);
        const accepted = Math.max(0, producedQty - reject - rework);

        const quality = producedQty > 0
          ? Math.min(100, (accepted / producedQty) * 100)
          : 0;

        const oee = (availability / 100) * (performance / 100) * (quality / 100) * 100;

        // Upsert into oee_hourly
        await db.query(
          `INSERT INTO oee_hourly
             (machine_id, shift_id, hour_start, availability, performance, quality, oee)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (machine_id, hour_start)
           DO UPDATE SET
             shift_id     = EXCLUDED.shift_id,
             availability = EXCLUDED.availability,
             performance  = EXCLUDED.performance,
             quality      = EXCLUDED.quality,
             oee          = EXCLUDED.oee`,
          [
            row.machine_id,
            shift.id,
            hourStart,
            Number(availability.toFixed(2)),
            Number(performance.toFixed(2)),
            Number(quality.toFixed(2)),
            Number(oee.toFixed(2))
          ]
        );
      }
    }

    console.log('Hourly OEE calculated:', hourStart.toISOString());
  } catch (err) {
    console.error('hourlyOee.job error:', err.message);
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
