const db = require('../db');

exports.log = async ({ user_id, company_id, action, resource, resource_id, old_value, new_value, ip_address, user_agent }) => {
  try {
    await db.query(
      `INSERT INTO audit_logs (user_id, company_id, action, resource, resource_id, old_value, new_value, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [user_id || null, company_id || null, action, resource || null, resource_id ? String(resource_id) : null,
       old_value ? JSON.stringify(old_value) : null,
       new_value ? JSON.stringify(new_value) : null,
       ip_address || null, user_agent || null]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
};

exports.getLogs = async ({ company_id, is_snt_super, resource, action, from_date, to_date, page = 1, limit = 50 }) => {
  const conditions = [];
  const params = [];
  let i = 1;

  if (!is_snt_super) {
    conditions.push(`a.company_id = $${i++}`);
    params.push(company_id);
  }
  if (resource) { conditions.push(`a.resource = $${i++}`); params.push(resource); }
  if (action)   { conditions.push(`a.action = $${i++}`);   params.push(action); }
  if (from_date){ conditions.push(`a.created_at >= $${i++}`); params.push(from_date); }
  if (to_date)  { conditions.push(`a.created_at <= $${i++}`); params.push(to_date); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(200, parseInt(limit) || 50);
  const offset = (pageNum - 1) * limitNum;

  const countRes = await db.query(
    `SELECT COUNT(*) FROM audit_logs a ${where}`, params
  );
  const total = parseInt(countRes.rows[0].count);

  const dataRes = await db.query(
    `SELECT a.*, u.username, u.email
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT $${i++} OFFSET $${i++}`,
    [...params, limitNum, offset]
  );

  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) } };
};
