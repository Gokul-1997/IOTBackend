const db = require('../db');

exports.startJob = async (req) => {

  const { machine_id, component_id, job_start } = req.body;
  const plant_id = req.user.plant_id;
  const company_id = req.user.company_id;

  if (!job_start) throw new Error("job_start (date & time) is required");

  // Block if machine already has an active job
  const { rows: existing } = await db.query(`
    SELECT j.id, j.part_name
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    WHERE j.machine_id = $1 AND j.is_active = TRUE AND m.company_id = $2
  `, [machine_id, company_id]);

  if (existing.length > 0) {
    throw new Error(`Machine already has an active job (${existing[0].part_name}). Stop it before starting a new one.`);
  }

  const { rows } = await db.query(`
    SELECT part_name, target
    FROM components
    WHERE id = $1
  `,[component_id]);

  const component = rows[0];

  if (!component) {
    throw new Error("Component not found");
  }

  await db.query(`
    INSERT INTO machine_current_job
    (plant_id,company_id,machine_id,component_id,part_name,target_qty,started_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `,[
    plant_id,
    company_id,
    machine_id,
    component_id,
    component.part_name,
    component.target,
    job_start
  ]);

};



exports.stopJob = async (machine_id, company_id) => {

  // Guard: no active job means nothing to stop
  const { rows: active } = await db.query(`
    SELECT j.id, j.part_name
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    WHERE j.machine_id = $1 AND j.is_active = TRUE AND m.company_id = $2
  `, [machine_id, company_id]);

  if (active.length === 0) {
    throw new Error('No active job found for this machine.');
  }

  await db.query(`
    UPDATE machine_current_job
    SET is_active = false,
        ended_at = now(),
        setting_time_end = now()
    WHERE machine_id = $1
      AND is_active = true
  `,[machine_id]);

  return true;

};



exports.getAvailableMachines = async (company_id) => {
  const { rows } = await db.query(`
    SELECT m.id, m.machine_serial_no
    FROM machines m
    WHERE m.company_id = $1
      AND m.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM machine_current_job j
        WHERE j.machine_id = m.id AND j.is_active = TRUE
      )
    ORDER BY m.machine_serial_no
  `, [company_id]);
  return rows;
};

exports.getCurrentJobs = async (company_id) => {

  const { rows } = await db.query(`
    SELECT
      m.id AS machine_id,
      m.machine_serial_no,
      j.id AS job_id,
      j.part_name,
      j.target_qty,
      j.started_at
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    WHERE m.company_id = $1
      AND m.is_active = TRUE
      AND j.is_active = TRUE
    ORDER BY j.started_at DESC
  `,[company_id]);

  return rows;

};

exports.getJobHistory = async (company_id) => {

  const { rows } = await db.query(`
    SELECT
      m.machine_serial_no,
      j.part_name,
      j.target_qty,
      j.started_at,
      j.ended_at,
      j.is_active
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    WHERE m.company_id = $1
    ORDER BY j.started_at DESC
    LIMIT 200
  `,[company_id]);

  return rows;

};