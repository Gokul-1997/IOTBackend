const db = require('../db');
const { getCurrentShift } = require('../utils/shift.util');

module.exports = async () => {
  const now = new Date();

  const plants = await db.query(
    `SELECT id FROM plants WHERE is_active=TRUE`
  );

  for (const p of plants.rows) {
    const shift = await getCurrentShift(p.id, now);
    if (shift) continue; // shift not ended yet

    const shiftEnd = new Date(now);
    const shiftStart = new Date(shiftEnd);
    shiftStart.setHours(shiftEnd.getHours() - 8); // example

    await db.query(
      `/* SQL ABOVE */`,
      [shift.id, shiftStart, shiftEnd]
    );
  }

  console.log('Shift OEE rollup done');
};
