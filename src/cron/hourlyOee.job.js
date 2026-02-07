const db = require('../db');
const { getCurrentShift } = require('../utils/shift.util');

module.exports = async () => {
  const hourStart =
    new Date(new Date().setMinutes(0, 0, 0) - 60 * 60 * 1000);
  const hourEnd =
    new Date(new Date().setMinutes(0, 0, 0));

  const plants = await db.query(`SELECT id FROM plants WHERE is_active=TRUE`);

  for (const p of plants.rows) {
    const shift = await getCurrentShift(p.id, hourStart);
    if (!shift) continue;

    // 1️⃣ production_hourly
    await db.query(
      `/* production aggregation SQL from step 3 */`,
      [hourStart, hourEnd, shift.id]
    );

    // 2️⃣ oee_hourly
    await db.query(
      `/* oee calculation SQL from step 4 */`,
      [hourStart]
    );
  }

  console.log('Hourly OEE calculated:', hourStart);
};
