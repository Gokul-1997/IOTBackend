const db = require('../db');

exports.startJob = async (req) => {

  const { machine_id, component_id, job_start } = req.body;
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
    WHERE id = $1 AND machine_id = $2
  `,[component_id, machine_id]);

  const component = rows[0];

  if (!component) {
    throw new Error("Component not found or does not belong to this machine");
  }

  await db.query(`
    INSERT INTO machine_current_job
    (plant_id,company_id,machine_id,component_id,part_name,target_qty,started_at)
    VALUES (NULL,$1,$2,$3,$4,$5,$6)
  `,[
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

/**
 * Currently running jobs, newest first.
 *
 * Bounded by machine count in practice, but paginated on the same opt-in
 * terms as the history so both endpoints answer in one shape.
 */
exports.getCurrentJobs = async (company_id, { page, limit } = {}) => {

  const paginated = page != null || limit != null;

  const lim    = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const pg     = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pg - 1) * lim;

  const where = `
    WHERE m.company_id = $1
      AND m.is_active = TRUE
      AND j.is_active = TRUE`;

  const select = `
    SELECT
      m.id AS machine_id,
      m.machine_serial_no,
      j.id AS job_id,
      j.part_name,
      j.target_qty,
      j.started_at
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    ${where}
    ORDER BY j.started_at DESC, j.id DESC`;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    ${where}`;

  const [dataRes, countRes] = await Promise.all([
    db.query(paginated ? `${select} LIMIT $2 OFFSET $3` : select,
             paginated ? [company_id, lim, offset] : [company_id]),
    db.query(countSql, [company_id])
  ]);

  // tolerate an empty count result rather than throwing on .total
  const total = countRes.rows[0]?.total ?? dataRes.rows.length;

  return {
    data:       dataRes.rows,
    total,
    page:       paginated ? pg : 1,
    limit:      paginated ? lim : total,
    totalPages: paginated ? Math.max(Math.ceil(total / lim), 1) : 1
  };

};

/**
 * Job history, newest first.
 *
 * This used to be a bare `LIMIT 200` with no offset and no total: once a
 * company passed 200 jobs the older ones were simply unreachable, and no
 * client could have paged to them because the row count was never returned.
 *
 * Pagination is opt-in so existing callers are unaffected — omit page/limit
 * and you get the whole history as before (minus the silent truncation).
 */
exports.getJobHistory = async (company_id, { page, limit } = {}) => {

  const paginated = page != null || limit != null;

  // clamp: a caller asking for limit=100000 should not be able to pull the
  // whole table into memory
  const lim    = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const pg     = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pg - 1) * lim;

  const where  = `WHERE m.company_id = $1`;
  const select = `
    SELECT
      j.id AS job_id,
      m.id AS machine_id,
      m.machine_serial_no,
      j.part_name,
      j.target_qty,
      j.started_at,
      j.ended_at,
      j.is_active
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    ${where}
    ORDER BY j.started_at DESC, j.id DESC`;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    ${where}`;

  const [dataRes, countRes] = await Promise.all([
    db.query(paginated ? `${select} LIMIT $2 OFFSET $3` : select,
             paginated ? [company_id, lim, offset] : [company_id]),
    db.query(countSql, [company_id])
  ]);

  // tolerate an empty count result rather than throwing on .total
  const total = countRes.rows[0]?.total ?? dataRes.rows.length;

  return {
    data:       dataRes.rows,
    total,
    page:       paginated ? pg : 1,
    limit:      paginated ? lim : total,
    totalPages: paginated ? Math.max(Math.ceil(total / lim), 1) : 1
  };

};