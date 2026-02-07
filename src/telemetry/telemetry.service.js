const db = require('../db');

exports.insert = async (machine, data) => {
  await db.query(
    `INSERT INTO telemetry_raw
     (plant_id, machine_id, status, rpm, feed_rate, part_count)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      machine.plant_id,
      machine.machine_id,
      data.status,
      data.rpm,
      data.feed_rate,
      data.part_count
    ]
  );
};
