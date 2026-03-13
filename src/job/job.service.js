const db = require('../db');

exports.startJob = async (req) => {

  const { machine_id, component_id } = req.body;
  const plant_id = req.user.plant_id;

  const { rows } = await db.query(`
    SELECT part_name, target
    FROM components
    WHERE id = $1
  `,[component_id]);

  const component = rows[0];

  if(!component){
    throw new Error("Component not found");
  }

  await db.query(`
    INSERT INTO machine_current_job
    (plant_id,machine_id,component_id,part_name,target_qty)
    VALUES ($1,$2,$3,$4,$5)
  `,[
    plant_id,
    machine_id,
    component_id,
    component.part_name,
    component.target
  ]);

};



exports.stopJob = async (machine_id) => {

  await db.query(`
    UPDATE machine_current_job
    SET is_active = false,
        ended_at = now()
    WHERE machine_id = $1
      AND is_active = true
  `,[machine_id]);

  return true;

};



exports.getCurrentJobs = async (plant_id) => {

  const { rows } = await db.query(`
    SELECT
      m.id AS machine_id,
      m.machine_serial_no,
      j.id AS job_id,
      j.part_name,
      j.target_qty

    FROM machines m

    LEFT JOIN machine_current_job j
      ON j.machine_id = m.id
      AND j.is_active = true

    WHERE m.plant_id = $1
    AND m.is_active = true

    ORDER BY m.id
  `,[plant_id]);

  return rows;

};