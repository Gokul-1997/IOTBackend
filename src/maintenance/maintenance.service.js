const db = require('../db');
const { pagination } = require('../lib/pagination');
const valid = require('../lib/work-validation');
const TYPES = ['PREVENTIVE', 'CORRECTIVE', 'PREDICTIVE', 'INSPECTION'];
const STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'OVERDUE'];
const RECURRENCES = ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];
const { ownedOrThrow } = require('../lib/tenant');
const { addMachinePlantScope } = require('../lib/plant-scope');

exports.getSchedules = async ({ company_id, machine_id, status, page = 1, limit = 20, plant_id = null }) => {
  const conditions = [`ms.company_id = $1`, `ms.is_active = true`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`ms.machine_id = $${i++}`); params.push(machine_id); }
  if (status)     { conditions.push(`ms.status = $${i++}`); params.push(status); }

  addMachinePlantScope(conditions, params, 'ms', plant_id);
  i = params.length + 1;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const { pageNum, limitNum, offset } = pagination(page, limit);

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM maintenance_schedules ms ${where}`, params),
    db.query(
      `SELECT ms.*, m.machine_serial_no
       FROM maintenance_schedules ms
       JOIN machines m ON m.id = ms.machine_id
       ${where}
       ORDER BY ms.scheduled_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    )
  ]);

  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum, total: parseInt(countRes.rows[0].count), totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum) } };
};

exports.createSchedule = async ({ company_id, machine_id, title, description, maintenance_type, scheduled_at, estimated_duration_minutes, assigned_to, recurrence, created_by, plant_id = null }) => {
  if (!machine_id) throw { status: 400, message: 'machine_id is required' };
  const name = valid.title(title);
  const when = valid.date(scheduled_at, 'scheduled_at', true);
  const type = valid.oneOf(maintenance_type, 'maintenance_type', TYPES, 'PREVENTIVE');
  const recur = valid.oneOf(recurrence, 'recurrence', RECURRENCES, 'NONE');
  const minutes = valid.nonnegative(estimated_duration_minutes, 'estimated_duration_minutes', { integer: true }) ?? 60;
  // assigned_to is the existing free-text technician name; assigned_user_id
  // on recurring schedules is the separate company-owned user reference.
  if (assigned_to != null && String(assigned_to).length > 200) throw { status: 400, message: 'Technician name is too long' };
  await ownedOrThrow(company_id, { machine_id });
  const res = await db.query(
    `INSERT INTO maintenance_schedules
       (company_id, machine_id, title, description, maintenance_type, scheduled_at,
        estimated_duration_minutes, assigned_to, recurrence, created_by, frequency, next_due_at)
     ${plant_id == null ? 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)' : `SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 WHERE EXISTS
       (SELECT 1 FROM machines WHERE id=$2 AND company_id=$1 AND plant_id=$13)`} RETURNING *`,
    [company_id, machine_id, name, description || null, type, when, minutes,
     assigned_to || null, recur, created_by, recur === 'NONE' ? null : recur, recur === 'NONE' ? null : when,
     ...(plant_id == null ? [] : [plant_id])]
  );
  if (!res.rowCount) throw { status: 404, message: 'Machine not found in your plant' };
  return res.rows[0];
};

exports.updateSchedule = async (id, company_id, fields, plant_id = null) => {
  await ownedOrThrow(company_id, { maintenance_schedule_id: id });
  const patch = {};
  if (fields.title !== undefined) patch.title = valid.title(fields.title);
  if (fields.description !== undefined) patch.description = fields.description || null;
  if (fields.maintenance_type !== undefined) patch.maintenance_type = valid.oneOf(fields.maintenance_type, 'maintenance_type', TYPES);
  if (fields.scheduled_at !== undefined) patch.scheduled_at = valid.date(fields.scheduled_at, 'scheduled_at', true);
  if (fields.estimated_duration_minutes !== undefined) patch.estimated_duration_minutes = valid.nonnegative(fields.estimated_duration_minutes, 'estimated_duration_minutes', { integer: true });
  if (fields.assigned_to !== undefined) {
    if (fields.assigned_to != null && String(fields.assigned_to).length > 200) throw { status: 400, message: 'Technician name is too long' };
    patch.assigned_to = fields.assigned_to || null;
  }
  if (fields.status !== undefined) patch.status = valid.oneOf(fields.status, 'status', STATUSES);
  if (fields.recurrence !== undefined) {
    patch.recurrence = valid.oneOf(fields.recurrence, 'recurrence', RECURRENCES);
    patch.frequency = patch.recurrence === 'NONE' ? null : patch.recurrence;
  }
  if (!Object.keys(patch).length) throw { status: 400, message: 'Nothing to update' };
  const values = Object.values(patch);
  const setters = Object.keys(patch).map((key, index) => `${key} = $${index + 1}`);
  if ('frequency' in patch) {
    const frequencyIndex = Object.keys(patch).indexOf('frequency') + 1;
    const whenIndex = Object.keys(patch).indexOf('scheduled_at') + 1;
    setters.push(`next_due_at = CASE WHEN $${frequencyIndex}::maintenance_frequency IS NULL THEN NULL ELSE ${whenIndex ? '$' + whenIndex : 'COALESCE(next_due_at, scheduled_at)'} END`);
  } else if (patch.scheduled_at) {
    const whenIndex = Object.keys(patch).indexOf('scheduled_at') + 1;
    setters.push(`next_due_at = CASE WHEN frequency IS NOT NULL THEN $${whenIndex} ELSE next_due_at END`);
  }
  values.push(id, company_id);
  const scope = plant_id == null ? '' : ` AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id = maintenance_schedules.machine_id AND scoped_machine.company_id = $${values.length} AND scoped_machine.plant_id = $${values.length + 1})`;
  const idIndex = values.length - 1, companyIndex = values.length;
  if (plant_id != null) values.push(plant_id);
  const res = await db.query(
    `UPDATE maintenance_schedules SET ${setters.join(', ')}, updated_at = NOW()
      WHERE id = $${idIndex} AND company_id = $${companyIndex}${scope} RETURNING *`, values
  );
  if (!res.rowCount) throw { status: 404, message: 'Schedule not found' };
  return res.rows[0];
};

exports.deleteSchedule = async (id, company_id, plant_id = null) => {
  const res = await db.query(
    `UPDATE maintenance_schedules SET is_active = false WHERE id = $1 AND company_id = $2
      ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id = maintenance_schedules.machine_id AND scoped_machine.company_id=$2 AND scoped_machine.plant_id=$3)'} RETURNING id`,
    [id, company_id, ...(plant_id == null ? [] : [plant_id])]
  );
  if (!res.rowCount) throw { status: 404, message: 'Schedule not found' };
};

exports.getLogs = async ({ company_id, machine_id, page = 1, limit = 20, plant_id = null }) => {
  const conditions = [`ml.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`ml.machine_id = $${i++}`); params.push(machine_id); }
  addMachinePlantScope(conditions, params, 'ml', plant_id);
  i = params.length + 1;

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { pageNum, limitNum, offset } = pagination(page, limit);

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM maintenance_logs ml ${where}`, params),
    db.query(
      `SELECT ml.*, m.machine_serial_no
       FROM maintenance_logs ml
       JOIN machines m ON m.id = ml.machine_id
       ${where}
       ORDER BY ml.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    )
  ]);

  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum, total: parseInt(countRes.rows[0].count), totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum) } };
};

exports.createLog = async ({ company_id, machine_id, maintenance_schedule_id, title, maintenance_type, started_at, completed_at, duration_minutes, technician_name, work_performed, parts_replaced, cost, status, logged_by, plant_id = null }) => {
  if (!machine_id || !title || !started_at) throw { status: 400, message: 'machine_id, title, started_at required' };
  const name = valid.title(title);
  const { from, to } = valid.window(started_at, completed_at, 'started_at', 'completed_at');
  const duration = valid.nonnegative(duration_minutes, 'duration_minutes', { integer: true })
    ?? (to ? Math.round((to - from) / 60000) : null);
  const money = valid.nonnegative(cost, 'cost');
  const type = valid.oneOf(maintenance_type, 'maintenance_type', TYPES, 'CORRECTIVE');
  const state = valid.oneOf(status, 'status', STATUSES, 'COMPLETED');
  await ownedOrThrow(company_id, { machine_id, maintenance_schedule_id });
  if (maintenance_schedule_id) {
    const { rows } = await db.query(
      'SELECT id FROM maintenance_schedules WHERE id = $1 AND company_id = $2 AND machine_id = $3',
      [maintenance_schedule_id, company_id, machine_id]
    );
    if (!rows.length) throw { status: 404, message: 'Schedule not found for this machine' };
  }
  const res = await db.query(
    `INSERT INTO maintenance_logs (company_id, machine_id, maintenance_schedule_id, title, maintenance_type, started_at, completed_at, duration_minutes, technician_name, work_performed, parts_replaced, cost, status, logged_by)
     ${plant_id == null ? 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)' : `SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 WHERE EXISTS
       (SELECT 1 FROM machines WHERE id=$2 AND company_id=$1 AND plant_id=$15)`} RETURNING *`,
    [company_id, machine_id, maintenance_schedule_id || null, name,
     type, from, to,
     duration, technician_name || null, work_performed || null,
     parts_replaced || null, money, state, logged_by, ...(plant_id == null ? [] : [plant_id])]
  );
  if (!res.rowCount) throw { status: 404, message: 'Machine not found in your plant' };
  return res.rows[0];
};

exports.getUpcoming = async (company_id, days = 7, plant_id = null) => {
  const horizon = Math.min(90, Math.max(1, parseInt(days, 10) || 7));
  const res = await db.query(
    `SELECT ms.*, m.machine_serial_no
     FROM maintenance_schedules ms
     JOIN machines m ON m.id = ms.machine_id
     WHERE ms.company_id = $1
       ${plant_id == null ? '' : 'AND m.company_id=$1 AND m.plant_id=$3'}
       AND ms.status IN ('SCHEDULED','OVERDUE')
       AND ms.is_active = true
       AND ms.scheduled_at BETWEEN NOW() AND NOW() + make_interval(days => $2)
     ORDER BY ms.scheduled_at ASC LIMIT 200`,
    [company_id, horizon, ...(plant_id == null ? [] : [plant_id])]
  );
  return res.rows;
};

exports.getMTTR = async ({ company_id, machine_id, from_date, to_date, plant_id = null }) => {
  const conditions = [`ml.company_id = $1`, `ml.completed_at IS NOT NULL`];
  const params = [company_id];
  let i = 2;
  if (machine_id) { conditions.push(`ml.machine_id = $${i++}`); params.push(machine_id); }
  if (from_date)  { conditions.push(`ml.started_at >= $${i++}`); params.push(from_date); }
  if (to_date)    { conditions.push(`ml.started_at <= $${i++}`); params.push(to_date); }
  addMachinePlantScope(conditions, params, 'ml', plant_id);

  const res = await db.query(
    `SELECT m.machine_serial_no,
            COUNT(*) as total_events,
            AVG(ml.duration_minutes) as avg_repair_minutes,
            SUM(ml.duration_minutes) as total_downtime_minutes
     FROM maintenance_logs ml
     JOIN machines m ON m.id = ml.machine_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY m.id, m.machine_serial_no
     ORDER BY avg_repair_minutes DESC`,
    params
  );
  return res.rows;
};
