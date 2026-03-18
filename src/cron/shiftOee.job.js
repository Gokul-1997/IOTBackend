const db = require('../db');
const { getCurrentShift } = require('../utils/shift.util');

/*
 * Runs every 10 minutes.
 * When a shift has just ended, rolls up oee_hourly rows
 * for that shift into oee_shift_summary.
 *
 * Strategy: look for a shift that ended in the last 10 minutes.
 * If found, aggregate all oee_hourly rows for that shift/date.
 */

module.exports = async () => {
  const now = new Date();

  try {
    const { rows: plants } = await db.query(
      `SELECT id FROM plants WHERE is_active = TRUE`
    );

    for (const plant of plants) {
      // Find shifts that ended within the last 10 minutes
      const { rows: endedShifts } = await db.query(
        `SELECT s.*
         FROM shifts s
         WHERE s.plant_id = $1
           AND s.is_active = TRUE
           AND (
             -- Normal shift: end_time crossed in last 10 min
             (s.start_time < s.end_time
               AND (NOW() AT TIME ZONE 'Asia/Kolkata')::time
                 BETWEEN s.end_time AND (s.end_time + INTERVAL '10 minutes')::time)
             OR
             -- Overnight shift: end_time crossed in last 10 min (early morning)
             (s.start_time > s.end_time
               AND (NOW() AT TIME ZONE 'Asia/Kolkata')::time
                 BETWEEN s.end_time AND (s.end_time + INTERVAL '10 minutes')::time)
           )`,
        [plant.id]
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

        // Get all machines for this plant
        const { rows: machines } = await db.query(
          `SELECT id FROM machines WHERE plant_id = $1 AND is_active = TRUE`,
          [plant.id]
        );

        for (const machine of machines) {
          // Aggregate oee_hourly for this machine + shift + date
          const { rows: aggRows } = await db.query(
            `SELECT
               AVG(availability) AS availability,
               AVG(performance)  AS performance,
               AVG(quality)      AS quality,
               AVG(oee)          AS oee
             FROM oee_hourly
             WHERE machine_id  = $1
               AND shift_id    = $2
               AND hour_start::date = $3::date`,
            [machine.id, shift.id, shiftDate]
          );

          const agg = aggRows[0];

          // Only write if we have data
          if (!agg || agg.oee === null) continue;

          await db.query(
            `INSERT INTO oee_shift_summary
               (machine_id, shift_id, shift_date, availability, performance, quality, oee)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (machine_id, shift_id, shift_date)
             DO UPDATE SET
               availability = EXCLUDED.availability,
               performance  = EXCLUDED.performance,
               quality      = EXCLUDED.quality,
               oee          = EXCLUDED.oee`,
            [
              machine.id,
              shift.id,
              shiftDate,
              Number(Number(agg.availability).toFixed(2)),
              Number(Number(agg.performance).toFixed(2)),
              Number(Number(agg.quality).toFixed(2)),
              Number(Number(agg.oee).toFixed(2))
            ]
          );
        }

        console.log(`Shift OEE rollup done: plant=${plant.id} shift=${shift.shift_code} date=${shiftDate}`);
      }
    }
  } catch (err) {
    console.error('shiftOee.job error:', err.message);
  }
};
