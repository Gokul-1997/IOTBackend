const db = require('../db');
const { plantSql, sharedEntityPlantSql } = require('../lib/read-scope');

function calendarDate(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error(`${name} must be a valid YYYY-MM-DD calendar date.`), { status: 400 });
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error(`${name} must be a valid YYYY-MM-DD calendar date.`), { status: 400 });
  }
  return value;
}

exports.getOperatorPerformance = async ({ company_id, shift_id, from_date, to_date, page = 1, limit = 20 }) => {
  const from = calendarDate(from_date, 'from_date');
  const to = calendarDate(to_date, 'to_date');
  if (from && to && from > to) {
    throw Object.assign(new Error('from_date must not be after to_date.'), { status: 400 });
  }
  const shift = shift_id == null || shift_id === '' ? null : Number(shift_id);
  if (shift != null && (!Number.isSafeInteger(shift) || shift < 1)) {
    throw Object.assign(new Error('shift_id must be a positive whole number.'), { status: 400 });
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;
  const machinePlantScope = plantSql('m.id');

  const query = `
    WITH report_scope AS (
      SELECT $2::date AS from_day, $3::date AS to_day, $4::timestamptz AS as_of
    ), assignment_pairs AS (
      /* Duplicate active assignments must not multiply either source total. */
      SELECT DISTINCT o.id AS operator_id, m.id AS machine_id, s.id AS shift_id,
        s.start_time, s.end_time
      FROM operators o
      JOIN operator_machine_assignments oma ON oma.operator_id = o.id
        AND oma.is_active = TRUE AND oma.company_id = $1
      JOIN machines m ON m.id = oma.machine_id AND m.company_id = $1${machinePlantScope}
      JOIN operator_shift_assignments osa ON osa.operator_id = o.id
        AND osa.is_active = TRUE AND osa.company_id = $1
      JOIN shifts s ON s.id = osa.shift_id AND s.company_id = $1${sharedEntityPlantSql('s')}
      WHERE o.company_id = $1 AND ($5::int IS NULL OR s.id = $5)
    ), production_totals AS (
      SELECT a.operator_id, SUM(ph.produced_qty) AS total_produced,
        SUM(ph.run_seconds) AS total_run_seconds, SUM(ph.idle_seconds) AS total_idle_seconds
      FROM assignment_pairs a
      JOIN production_hourly ph ON ph.machine_id = a.machine_id
        AND ph.shift_id = a.shift_id AND ph.company_id = $1
      CROSS JOIN report_scope w
      WHERE ph.hour_start < w.as_of
        /* Dates identify the day a shift starts, including its overnight tail.
           Overlap includes a shift's first partial clock-hour bucket. */
        AND (w.from_day IS NULL OR ph.hour_start + INTERVAL '1 hour' >
          (w.from_day + a.start_time) AT TIME ZONE 'Asia/Kolkata')
        AND (w.to_day IS NULL OR ph.hour_start <
          (CASE WHEN a.start_time >= a.end_time
             THEN w.to_day + INTERVAL '1 day' + a.end_time
             ELSE w.to_day + a.end_time END) AT TIME ZONE 'Asia/Kolkata')
        /* A preloaded partial-hour bucket cannot make an unstarted shift real. */
        AND (
          ((w.as_of AT TIME ZONE 'Asia/Kolkata')::date + a.start_time) AT TIME ZONE 'Asia/Kolkata' <= w.as_of
          OR ph.hour_start + INTERVAL '1 hour' <=
            ((w.as_of AT TIME ZONE 'Asia/Kolkata')::date + a.start_time) AT TIME ZONE 'Asia/Kolkata'
        )
      GROUP BY a.operator_id
    ), quality_totals AS (
      /* Shift quality totals are independent of the number of hourly rows. */
      SELECT a.operator_id, SUM(qe.reject_qty) AS total_rejected
      FROM assignment_pairs a
      JOIN quality_entries qe ON qe.machine_id = a.machine_id AND qe.shift_id = a.shift_id
      CROSS JOIN report_scope w
      WHERE (w.from_day IS NULL OR COALESCE(qe.shift_date,
          (qe.created_at AT TIME ZONE 'Asia/Kolkata')::date) >= w.from_day)
        AND (w.to_day IS NULL OR COALESCE(qe.shift_date,
          (qe.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= w.to_day)
        AND (COALESCE(qe.shift_date, (qe.created_at AT TIME ZONE 'Asia/Kolkata')::date)
          + a.start_time) AT TIME ZONE 'Asia/Kolkata' <= w.as_of
      GROUP BY a.operator_id
    ), machine_totals AS (
      SELECT operator_id, COUNT(DISTINCT machine_id) AS machines_operated
      FROM assignment_pairs GROUP BY operator_id
    )
    SELECT o.id AS operator_id, o.operator_name, o.operator_code,
      COALESCE(mt.machines_operated, 0) AS machines_operated,
      COALESCE(p.total_produced, 0) AS total_produced,
      COALESCE(p.total_run_seconds, 0) AS total_run_seconds,
      COALESCE(p.total_idle_seconds, 0) AS total_idle_seconds,
      COALESCE(q.total_rejected, 0) AS total_rejected,
      CASE WHEN p.total_produced > 0
        THEN ROUND(100.0 * GREATEST(0, 1 - COALESCE(q.total_rejected, 0)::NUMERIC / p.total_produced), 2)
        ELSE 0 END AS quality_rate,
      CASE WHEN COALESCE(p.total_run_seconds, 0) + COALESCE(p.total_idle_seconds, 0) > 0
        THEN ROUND(100.0 * p.total_run_seconds::NUMERIC /
          (COALESCE(p.total_run_seconds, 0) + COALESCE(p.total_idle_seconds, 0)), 2)
        ELSE 0 END AS utilization_rate
    FROM operators o
    LEFT JOIN machine_totals mt ON mt.operator_id = o.id
    LEFT JOIN production_totals p ON p.operator_id = o.id
    LEFT JOIN quality_totals q ON q.operator_id = o.id
    WHERE o.company_id = $1
      AND ($5::int IS NULL OR mt.operator_id IS NOT NULL)
      ${machinePlantScope ? 'AND mt.operator_id IS NOT NULL' : ''}
    ORDER BY total_produced DESC, o.id
    LIMIT $6 OFFSET $7
  `;

  const dataRes = await db.query(query, [company_id, from, to, new Date().toISOString(), shift, limitNum, offset]);
  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum } };
};
