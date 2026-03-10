const db = require("../db");

const getMachineListService = async (plant_id) => {
  const query = `
    SELECT id, machine_serial_no
    FROM machines
    WHERE plant_id = $1
      AND is_active = true
    ORDER BY machine_serial_no
  `;
  const result = await db.query(query, [plant_id]);
  return result.rows;
};

const getShiftListService = async (plant_id) => {
  const query = `
    SELECT id, shift_code, shift_name, start_time, end_time
    FROM shifts
    WHERE plant_id = $1
      AND is_active = true
    ORDER BY start_time
  `;
  const result = await db.query(query, [plant_id]);
  return result.rows;
};
const getMachinesByLineService = async (line_id, plant_id) => {

  if (!line_id) {
    throw new Error("Line ID required");
  }

  const result = await db.query(
    `SELECT id, machine_serial_no
     FROM machines
     WHERE plant_id = $1
       AND line_id = $2
       AND is_active = true
     ORDER BY machine_serial_no`,
    [plant_id, line_id]
  );

  return result.rows;
};



module.exports = {
  getMachineListService,
  getShiftListService,
  getMachinesByLineService
};