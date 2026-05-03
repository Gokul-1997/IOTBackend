const db = require('../db');

exports.getSchedules = async ({ company_id, machine_id, status, page = 1, limit = 20 }) => {
  const conditions = [`ms.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`ms.machine_id = $${i++}`); params.push(machine_id); }
  if (status)     { conditions.push(`ms.status = $${i++}`); params.push(status); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

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

exports.createSchedule = async ({ company_id, machine_id, title, description, maintenance_type, scheduled_at, estimated_duration_minutes, assigned_to, recurrence, created_by }) => {
  if (!machine_id || !title || !scheduled_at) throw { status: 400, message: 'machine_id, title, and scheduled_at are required' };
  const res = await db.query(
    `INSERT INTO maintenance_schedules (company_id, machine_id, title, description, maintenance_type, scheduled_at, estimated_duration_minutes, assigned_to, recurrence, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [company_id, machine_id, title, description || null, maintenance_type || 'PREVENTIVE',
     scheduled_at, estimated_duration_minutes || 60, assigned_to || null, recurrence || 'NONE', created_by]
  );
  return res.rows[0];
};

exports.updateSchedule = async (id, company_id, fields) => {
  const { title, description, maintenance_type, scheduled_at, estimated_duration_minutes, assigned_to, status, recurrence } = fields;
  const res = await db.query(
    `UPDATE maintenance_schedules
     SET title=$1, description=$2, maintenance_type=$3, scheduled_at=$4,
         estimated_duration_minutes=$5, assigned_to=$6, status=$7, recurrence=$8, updated_at=NOW()
     WHERE id=$9 AND company_id=$10 RETURNING *`,
    [title, description, maintenance_type, scheduled_at, estimated_duration_minutes,
     assigned_to, status, recurrence, id, company_id]
  );
  if (!res.rowCount) throw { status: 404, message: 'Schedule not found' };
  return res.rows[0];
};

exports.deleteSchedule = async (id, company_id) => {
  await db.query(
    `UPDATE maintenance_schedules SET is_active = false WHERE id = $1 AND company_id = $2`,
    [id, company_id]
  );
};

exports.getLogs = async ({ company_id, machine_id, page = 1, limit = 20 }) => {
  const conditions = [`ml.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`ml.machine_id = $${i++}`); params.push(machine_id); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

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

exports.createLog = async ({ company_id, machine_id, maintenance_schedule_id, title, maintenance_type, started_at, completed_at, duration_minutes, technician_name, work_performed, parts_replaced, cost, status, logged_by }) => {
  if (!machine_id || !title || !started_at) throw { status: 400, message: 'machine_id, title, started_at required' };
  const res = await db.query(
    `INSERT INTO maintenance_logs (company_id, machine_id, maintenance_schedule_id, title, maintenance_type, started_at, completed_at, duration_minutes, technician_name, work_performed, parts_replaced, cost, status, logged_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [company_id, machine_id, maintenance_schedule_id || null, title,
     maintenance_type || 'CORRECTIVE', started_at, completed_at || null,
     duration_minutes || null, technician_name || null, work_performed || null,
     parts_replaced || null, cost || null, status || 'COMPLETED', logged_by]
  );
  return res.rows[0];
};

exports.getUpcoming = async (company_id, days = 7) => {
  const res = await db.query(
    `SELECT ms.*, m.machine_serial_no
     FROM maintenance_schedules ms
     JOIN machines m ON m.id = ms.machine_id
     WHERE ms.company_id = $1
       AND ms.status IN ('SCHEDULED','OVERDUE')
       AND ms.is_active = true
       AND ms.scheduled_at BETWEEN NOW() AND NOW() + INTERVAL '${parseInt(days)} days'
     ORDER BY ms.scheduled_at ASC`,
    [company_id]
  );
  return res.rows;
};

exports.getMTTR = async ({ company_id, machine_id, from_date, to_date }) => {
  const conditions = [`ml.company_id = $1`, `ml.completed_at IS NOT NULL`];
  const params = [company_id];
  let i = 2;
  if (machine_id) { conditions.push(`ml.machine_id = $${i++}`); params.push(machine_id); }
  if (from_date)  { conditions.push(`ml.started_at >= $${i++}`); params.push(from_date); }
  if (to_date)    { conditions.push(`ml.started_at <= $${i++}`); params.push(to_date); }

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
