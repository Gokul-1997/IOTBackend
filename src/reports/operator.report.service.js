const db = require('../db');

exports.getOperatorPerformance = async ({ company_id, shift_id, from_date, to_date, page = 1, limit = 20 }) => {
  const conditions = [`o.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (shift_id)  { conditions.push(`osa.shift_id = $${i++}`); params.push(shift_id); }
  if (from_date) { conditions.push(`ph.hour_start >= $${i++}`); params.push(from_date); }
  if (to_date)   { conditions.push(`ph.hour_start <= $${i++}`); params.push(to_date); }

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const query = `
    SELECT
      o.id as operator_id,
      o.operator_name,
      o.operator_code,
      COUNT(DISTINCT oma.machine_id) as machines_operated,
      COALESCE(SUM(ph.produced_qty), 0) as total_produced,
      COALESCE(SUM(ph.run_seconds), 0)  as total_run_seconds,
      COALESCE(SUM(ph.idle_seconds), 0) as total_idle_seconds,
      COALESCE(SUM(qe.reject_qty), 0)   as total_rejected,
      CASE WHEN COALESCE(SUM(ph.produced_qty),0) > 0
           THEN ROUND(100.0 * (1 - COALESCE(SUM(qe.reject_qty),0)::NUMERIC / NULLIF(SUM(ph.produced_qty),0)), 2)
           ELSE 0 END as quality_rate,
      CASE WHEN COALESCE(SUM(ph.run_seconds),0) + COALESCE(SUM(ph.idle_seconds),0) > 0
           THEN ROUND(100.0 * COALESCE(SUM(ph.run_seconds),0)::NUMERIC /
                NULLIF(SUM(ph.run_seconds)+SUM(ph.idle_seconds), 0), 2)
           ELSE 0 END as utilization_rate
    FROM operators o
    LEFT JOIN operator_machine_assignments oma ON oma.operator_id = o.id AND oma.is_active = true
    LEFT JOIN operator_shift_assignments osa   ON osa.operator_id = o.id AND osa.is_active = true
    LEFT JOIN production_hourly ph             ON ph.machine_id = oma.machine_id
                                               AND ph.shift_id = osa.shift_id
    LEFT JOIN quality_entries qe               ON qe.machine_id = oma.machine_id
                                               AND qe.shift_id = osa.shift_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY o.id, o.operator_name, o.operator_code
    ORDER BY total_produced DESC
    LIMIT $${i++} OFFSET $${i++}
  `;

  const dataRes = await db.query(query, [...params, limitNum, offset]);

  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum } };
};
