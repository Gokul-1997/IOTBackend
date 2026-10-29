const db = require('../db');
const { pagination } = require('../lib/pagination');
const { tableQuery } = require('../lib/table-query');
const { machineOrder } = require('../lib/machine-order');

function id(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw { status: 400, message: `${label} id is not valid` };
  return n;
}

/** Lock the owned machine, so simultaneous starts/stops are serialized.
 * Company and plant are checked before either components or jobs are read. */
async function lockedMachine(client, machineId, companyId, plantId) {
  if (!companyId) throw { status: 403, message: 'No company on this account' };
  const { rows } = await client.query(
    `SELECT id, plant_id FROM machines
      WHERE id = $1 AND company_id = $2 AND is_active = TRUE
        AND ($3::int IS NULL OR plant_id = $3)
      FOR UPDATE`,
    [machineId, companyId, plantId ?? null]
  );
  if (!rows.length) throw { status: 404, message: 'Machine not found' };
  return rows[0];
}

exports.startJob = async (req) => {
  const machineId = id(req.body.machine_id, 'Machine');
  const componentId = id(req.body.component_id, 'Component');
  const start = new Date(req.body.job_start);
  if (!req.body.job_start || !Number.isFinite(start.getTime())) {
    throw { status: 400, message: 'job_start must be a valid date and time' };
  }
  const companyId = req.user.company_id;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const machine = await lockedMachine(client, machineId, companyId, req.user.plant_id);
    const { rows: existing } = await client.query(
      `SELECT id, part_name FROM machine_current_job
        WHERE machine_id = $1 AND company_id = $2 AND is_active = TRUE`,
      [machineId, companyId]
    );
    if (existing.length) throw { status: 409, message: `Machine already has an active job (${existing[0].part_name}). Stop it before starting a new one.` };
    const { rows } = await client.query(
      `SELECT part_name, target, EXTRACT(EPOCH FROM cycle_time) AS cycle_time_seconds FROM components
        WHERE id = $1 AND machine_id = $2 AND company_id = $3`,
      [componentId, machineId, companyId]
    );
    if (!rows.length) throw { status: 404, message: 'Component not found or does not belong to this machine' };
    const result = await client.query(
      `INSERT INTO machine_current_job
         (plant_id, company_id, machine_id, component_id, part_name, target_qty, started_at, cycle_time_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [machine.plant_id, companyId, machineId, componentId, rows[0].part_name, rows[0].target, start, rows[0].cycle_time_seconds ?? null]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw { status: 409, message: 'Machine already has an active job. Refresh and try again.' };
    throw err;
  } finally { client.release(); }
};

exports.stopJob = async (machine_id, company_id, plant_id = null) => {
  const machineId = id(machine_id, 'Machine');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockedMachine(client, machineId, company_id, plant_id);
    const result = await client.query(
      `UPDATE machine_current_job
          SET is_active = FALSE, ended_at = NOW(), setting_time_end = NOW()
        WHERE machine_id = $1 AND company_id = $2 AND is_active = TRUE
        RETURNING id`,
      [machineId, company_id]
    );
    if (!result.rowCount) throw { status: 409, message: 'No active job found for this machine.' };
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
};

exports.getAvailableMachines = async (company_id, plant_id = null) => {
  const { rows } = await db.query(`
    SELECT m.id, m.machine_serial_no
    FROM machines m
    WHERE m.company_id = $1
      AND ($2::int IS NULL OR m.plant_id = $2)
      AND m.is_active = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM machine_current_job j
        WHERE j.machine_id = m.id AND j.is_active = TRUE
      )
    ORDER BY ${machineOrder('m.machine_serial_no')}
  `, [company_id, plant_id]);
  return rows;
};

/**
 * Currently running jobs, newest first.
 *
 * Bounded by machine count in practice, but paginated on the same opt-in
 * terms as the history so both endpoints answer in one shape.
 */
exports.getCurrentJobs = async (company_id, { page, limit, plant_id = null } = {}) => {

  const paginated = page != null || limit != null;

  const { limitNum: lim, pageNum: pg, offset } = pagination(page, limit, 200);
  const scoped = plant_id != null;
  const scopeParams = scoped ? [company_id, plant_id] : [company_id];

  const where = `
    WHERE m.company_id = $1 AND j.company_id = $1 ${scoped ? 'AND m.plant_id = $2' : ''}
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
    db.query(paginated ? `${select} LIMIT $${scopeParams.length + 1} OFFSET $${scopeParams.length + 2}` : select,
             paginated ? [...scopeParams, lim, offset] : scopeParams),
    db.query(countSql, scopeParams)
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
 * History is always bounded; clients send page/limit to navigate older work.
 */
/* The Job History table's header (lib/table-query.js, 29 Oct 2026): sort any
   column; filter the machine and the state; search the part. */
const JOB_TABLE = {
  sort: { machine: dir => machineOrder('m.machine_serial_no', dir), part: 'j.part_name', target: 'j.target_qty',
          started_at: 'j.started_at', ended_at: 'j.ended_at', status: 'j.is_active' },
  filter: { machine: 'm.machine_serial_no', status: 'j.is_active' },
  search: { part: 'j.part_name', machine: 'm.machine_serial_no' }
};

exports.getJobHistory = async (company_id, { page, limit, plant_id = null, query = {} } = {}) => {

  const paginated = true;

  // clamp: a caller asking for limit=100000 should not be able to pull the
  // whole table into memory
  const { limitNum: lim, pageNum: pg, offset } = pagination(page, limit, 200);
  const scoped = plant_id != null;
  const scopeParams = scoped ? [company_id, plant_id] : [company_id];
  const table = tableQuery(query, JOB_TABLE, scopeParams);

  const where  = `WHERE m.company_id = $1 AND j.company_id = $1 ${scoped ? 'AND m.plant_id = $2' : ''}${table.where.map(w => ` AND ${w}`).join('')}`;
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
    ORDER BY ${table.orderBy ? `${table.orderBy}, ` : ''}j.started_at DESC, j.id DESC`;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM machine_current_job j
    JOIN machines m ON m.id = j.machine_id
    ${where}`;

  const [dataRes, countRes] = await Promise.all([
    db.query(paginated ? `${select} LIMIT $${scopeParams.length + 1} OFFSET $${scopeParams.length + 2}` : select,
             paginated ? [...scopeParams, lim, offset] : scopeParams),
    db.query(countSql, scopeParams)
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
