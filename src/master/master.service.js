const db = require("../db");
const { sharedEntityPlantSql } = require("../lib/read-scope");

const getMachineListService = async (plant_id, company_id) => {
  // line_id lets a list of every machine be grouped by line (Quality's "All lines")
  const query = `
    SELECT id, machine_serial_no, line_id, plant_id
    FROM machines
    WHERE company_id = $1
      AND is_active = true
      AND ($2::int IS NULL OR plant_id = $2)
    ORDER BY machine_serial_no
  `;
  const result = await db.query(query, [company_id, plant_id]);
  return result.rows;
};

const getShiftListService = async (plant_id, company_id) => {
  const query = `
    SELECT id, shift_code, shift_name, start_time, end_time
    FROM shifts
    WHERE company_id = $1${sharedEntityPlantSql('shifts', plant_id, company_id)}
      AND is_active = true
    ORDER BY start_time
  `;
  const result = await db.query(query, [company_id]);
  return result.rows;
};
const getMachinesByLineService = async (line_id, plant_id, company_id) => {

  if (!line_id) {
    throw { status: 400, message: 'Line ID required' };
  }

  const result = await db.query(
    `SELECT id, machine_serial_no
     FROM machines
     WHERE company_id = $1
       AND line_id = $2
       AND ($3::int IS NULL OR plant_id = $3)
       AND is_active = true
     ORDER BY machine_serial_no`,
    [company_id, line_id, plant_id]
  );

  return result.rows;
};



module.exports = {
  getMachineListService,
  getShiftListService,
  getMachinesByLineService
};
module.exports.getPlantListService = async (plant_id, company_id) => {
  const { rows } = await db.query('SELECT id, plant_name FROM plants WHERE company_id = $1 AND is_active = TRUE AND ($2::int IS NULL OR id = $2) ORDER BY plant_name', [company_id, plant_id]);
  return rows;
};
