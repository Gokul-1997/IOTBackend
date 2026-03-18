const db = require('../db');

exports.startJob = async (req) => {

  const { machine_id, component_id, job_start, setting_time_start, setting_time_end } = req.body;
  const plant_id = req.user.plant_id;

  if (!job_start) throw new Error("job_start (date & time) is required");
  if (!setting_time_start) throw new Error("setting_time_start is required");
  if (!setting_time_end) throw new Error("setting_time_end is required");

  const { rows } = await db.query(`
    SELECT part_name, target
    FROM components
    WHERE id = $1
  `,[component_id]);

  const component = rows[0];

  if(!component){
    throw new Error("Component not found");
  }

  // Stop any existing active job for this machine before starting a new one
  await db.query(`
    UPDATE machine_current_job
    SET is_active = false, ended_at = now()
    WHERE machine_id = $1 AND is_active = true
  `,[machine_id]);

  await db.query(`
    INSERT INTO machine_current_job
    (plant_id,machine_id,component_id,part_name,target_qty,started_at,setting_time_start,setting_time_end)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `,[
    plant_id,
    machine_id,
    component_id,
    component.part_name,
    component.target,
    job_start,
    setting_time_start,
    setting_time_end
  ]);

};



exports.stopJob = async (machine_id, job_end) => {

  const end_time = job_end || 'now()';

  await db.query(`
    UPDATE machine_current_job
    SET is_active = false,
        ended_at = $2
    WHERE machine_id = $1
      AND is_active = true
  `,[machine_id, end_time === 'now()' ? new Date() : job_end]);

  return true;

};



exports.getCurrentJobs = async (plant_id) => {

  const { rows } = await db.query(`
    SELECT
      m.id AS machine_id,
      m.machine_serial_no,
      j.id AS job_id,
      j.part_name,
      j.target_qty,
      j.achieved_qty,
      j.started_at,
      j.ended_at,
      j.setting_time_start,
      j.setting_time_end,
      j.is_active

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