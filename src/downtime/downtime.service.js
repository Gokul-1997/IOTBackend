const db = require('../db');

exports.getReasons = async (company_id) => {
  const res = await db.query(
    `SELECT * FROM downtime_reasons
     WHERE (company_id = $1 OR company_id IS NULL) AND is_active = true
     ORDER BY category, name`,
    [company_id]
  );
  return res.rows;
};

exports.createReason = async ({ company_id, code, name, category }) => {
  if (!code || !name) throw { status: 400, message: 'Code and name are required' };
  const res = await db.query(
    `INSERT INTO downtime_reasons (company_id, code, name, category)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [company_id, code.toUpperCase(), name, category || 'UNPLANNED']
  );
  return res.rows[0];
};

exports.updateReason = async (id, company_id, { code, name, category, is_active }) => {
  const res = await db.query(
    `UPDATE downtime_reasons SET code=$1, name=$2, category=$3, is_active=$4
     WHERE id=$5 AND company_id=$6 RETURNING *`,
    [code?.toUpperCase(), name, category, is_active ?? true, id, company_id]
  );
  if (!res.rowCount) throw { status: 404, message: 'Reason not found' };
  return res.rows[0];
};

exports.logEvent = async ({ company_id, machine_id, shift_id, downtime_reason_id, started_at, ended_at, notes, entered_by }) => {
  if (!machine_id) throw { status: 400, message: 'machine_id is required' };
  const res = await db.query(
    `INSERT INTO downtime_events (company_id, machine_id, shift_id, downtime_reason_id, started_at, ended_at, notes, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [company_id, machine_id, shift_id || null, downtime_reason_id || null,
     started_at || new Date(), ended_at || null, notes || null, entered_by]
  );
  return res.rows[0];
};

exports.getEvents = async ({ company_id, machine_id, from_date, to_date, page = 1, limit = 20 }) => {
  const conditions = [`e.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`e.machine_id = $${i++}`); params.push(machine_id); }
  if (from_date)  { conditions.push(`e.started_at >= $${i++}`); params.push(from_date); }
  if (to_date)    { conditions.push(`e.started_at <= $${i++}`); params.push(to_date); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM downtime_events e ${where}`, params),
    db.query(
      `SELECT e.*, m.machine_serial_no, dr.name as reason_name, dr.category,
              u.username as entered_by_name
       FROM downtime_events e
       JOIN machines m ON m.id = e.machine_id
       LEFT JOIN downtime_reasons dr ON dr.id = e.downtime_reason_id
       LEFT JOIN users u ON u.id = e.entered_by
       ${where}
       ORDER BY e.started_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    )
  ]);

  return {
    data: dataRes.rows,
    pagination: { page: pageNum, limit: limitNum, total: parseInt(countRes.rows[0].count), totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum) }
  };
};

exports.getDowntimeSummary = async ({ company_id, from_date, to_date }) => {
  const res = await db.query(
    `SELECT dr.category, dr.name as reason_name, dr.code,
            COUNT(*) as event_count,
            SUM(e.duration_seconds) as total_seconds
     FROM downtime_events e
     LEFT JOIN downtime_reasons dr ON dr.id = e.downtime_reason_id
     WHERE e.company_id = $1
       AND e.started_at >= $2 AND e.started_at <= $3
       AND e.ended_at IS NOT NULL
     GROUP BY dr.category, dr.name, dr.code
     ORDER BY total_seconds DESC`,
    [company_id, from_date || 'NOW() - INTERVAL \'7 days\'', to_date || 'NOW()']
  );
  return res.rows;
};
