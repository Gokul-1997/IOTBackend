const db = require('../db');

exports.getPlans = async ({ company_id, machine_id, from_date, to_date, page = 1, limit = 20 }) => {
  const conditions = [`pp.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`pp.machine_id = $${i++}`); params.push(machine_id); }
  if (from_date)  { conditions.push(`pp.plan_date >= $${i++}`); params.push(from_date); }
  if (to_date)    { conditions.push(`pp.plan_date <= $${i++}`); params.push(to_date); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM production_plans pp ${where}`, params),
    db.query(
      `SELECT pp.*,
              m.machine_serial_no,
              c.part_number,
              s.shift_name,
              l.name as line_name,
              COALESCE((
                SELECT SUM(ph2.produced_qty)
                FROM production_hourly ph2
                WHERE ph2.machine_id = pp.machine_id
                  AND ph2.shift_id = pp.shift_id
                  AND DATE(ph2.hour_start) = pp.plan_date
              ), 0) as actual_qty
       FROM production_plans pp
       LEFT JOIN machines m    ON m.id = pp.machine_id
       LEFT JOIN components c  ON c.id = pp.component_id
       LEFT JOIN shifts s      ON s.id = pp.shift_id
       LEFT JOIN line l        ON l.id = pp.line_id
       ${where}
       ORDER BY pp.plan_date DESC, pp.id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    )
  ]);

  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum, total: parseInt(countRes.rows[0].count), totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum) } };
};

exports.createPlan = async ({ company_id, line_id, machine_id, component_id, plan_date, shift_id, planned_qty, notes, created_by }) => {
  if (!plan_date || !planned_qty) throw { status: 400, message: 'plan_date and planned_qty are required' };
  const res = await db.query(
    `INSERT INTO production_plans (company_id, line_id, machine_id, component_id, plan_date, shift_id, planned_qty, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [company_id, line_id || null, machine_id || null, component_id || null, plan_date, shift_id || null, planned_qty, notes || null, created_by]
  );
  return res.rows[0];
};

exports.updatePlan = async (id, company_id, { planned_qty, notes, component_id, shift_id }) => {
  const res = await db.query(
    `UPDATE production_plans SET planned_qty=$1, notes=$2, component_id=$3, shift_id=$4, updated_at=NOW()
     WHERE id=$5 AND company_id=$6 RETURNING *`,
    [planned_qty, notes, component_id, shift_id, id, company_id]
  );
  if (!res.rowCount) throw { status: 404, message: 'Plan not found' };
  return res.rows[0];
};

exports.deletePlan = async (id, company_id) => {
  const res = await db.query(
    `DELETE FROM production_plans WHERE id=$1 AND company_id=$2`, [id, company_id]
  );
  if (!res.rowCount) throw { status: 404, message: 'Plan not found' };
};

exports.getVarianceReport = async ({ company_id, from_date, to_date }) => {
  const res = await db.query(
    `SELECT
       pp.plan_date,
       m.machine_serial_no,
       s.shift_name,
       c.part_number,
       pp.planned_qty,
       COALESCE((
         SELECT SUM(ph.produced_qty)
         FROM production_hourly ph
         WHERE ph.machine_id = pp.machine_id
           AND ph.shift_id = pp.shift_id
           AND DATE(ph.hour_start) = pp.plan_date
       ), 0) as actual_qty,
       COALESCE((
         SELECT SUM(ph.produced_qty)
         FROM production_hourly ph
         WHERE ph.machine_id = pp.machine_id
           AND ph.shift_id = pp.shift_id
           AND DATE(ph.hour_start) = pp.plan_date
       ), 0) - pp.planned_qty as variance,
       CASE WHEN pp.planned_qty > 0 THEN
         ROUND(100.0 * COALESCE((
           SELECT SUM(ph.produced_qty)
           FROM production_hourly ph
           WHERE ph.machine_id = pp.machine_id
             AND ph.shift_id = pp.shift_id
             AND DATE(ph.hour_start) = pp.plan_date
         ), 0) / pp.planned_qty, 2)
       ELSE 0 END as achievement_pct
     FROM production_plans pp
     LEFT JOIN machines m   ON m.id = pp.machine_id
     LEFT JOIN shifts s     ON s.id = pp.shift_id
     LEFT JOIN components c ON c.id = pp.component_id
     WHERE pp.company_id = $1
       AND pp.plan_date BETWEEN $2 AND $3
     ORDER BY pp.plan_date DESC`,
    [company_id, from_date, to_date]
  );
  return res.rows;
};
