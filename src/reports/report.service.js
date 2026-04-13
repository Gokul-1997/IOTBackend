const db = require('../db');

/* ─── helpers ─── */

function secToHHMM(sec) {
  sec = Number(sec || 0);
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  return `${h}:${m}`;
}

/* ─── operator CTE used in all queries ───
   Gets the most recent active operator assigned to each machine.
   Using DISTINCT ON (machine_id) to get one row per machine.
*/
const OPERATOR_CTE = `
  op_map AS (
    SELECT DISTINCT ON (oma.machine_id)
      oma.machine_id,
      o.id            AS operator_id,
      o.operator_name
    FROM operator_machine_assignments oma
    JOIN operators o ON o.id = oma.operator_id AND o.is_active = TRUE
    WHERE oma.is_active = TRUE
    ORDER BY oma.machine_id, oma.id DESC
  )
`;

/* ─────────────────────────────────────────────────────────
   DROPDOWNS
───────────────────────────────────────────────────────── */

exports.getMachines = async (company_id) => {
  const { rows } = await db.query(
    `SELECT id, machine_serial_no AS name
     FROM machines
     WHERE company_id = $1 AND is_active = TRUE
     ORDER BY machine_serial_no`,
    [company_id]
  );
  return rows;
};

exports.getShifts = async (company_id) => {
  const { rows } = await db.query(
    `SELECT id, shift_code AS name
     FROM shifts
     WHERE company_id = $1 AND is_active = TRUE
     ORDER BY start_time`,
    [company_id]
  );
  return rows;
};

exports.getOperators = async (company_id) => {
  const { rows } = await db.query(
    `SELECT DISTINCT o.id, o.operator_name AS name
     FROM operators o
     JOIN operator_machine_assignments oma ON oma.operator_id = o.id AND oma.is_active = TRUE
     JOIN machines m ON m.id = oma.machine_id AND m.company_id = $1 AND m.is_active = TRUE
     WHERE o.is_active = TRUE
     ORDER BY o.operator_name`,
    [company_id]
  );
  return rows;
};

/* ─────────────────────────────────────────────────────────
   PRODUCTION REPORT  (JSON)
───────────────────────────────────────────────────────── */

exports.productionData = async (company_id, date_from, date_to, machine_id, shift_id, operator_id) => {
  const params = [company_id, date_from, date_to];
  const conds  = [];

  if (machine_id)  { params.push(machine_id);  conds.push(`p.machine_id       = $${params.length}`); }
  if (shift_id)    { params.push(shift_id);    conds.push(`p.shift_id         = $${params.length}`); }
  if (operator_id) { params.push(operator_id); conds.push(`op.operator_id     = $${params.length}`); }

  const extra = conds.length ? 'AND ' + conds.join(' AND ') : '';

  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}
    SELECT
      m.machine_serial_no                                                        AS machine,
      COALESCE(op.operator_name, '--')                                           AS operator,
      COALESCE(s.shift_code, '--')                                               AS shift,
      TO_CHAR(p.hour_start AT TIME ZONE 'Asia/Kolkata', 'DD-Mon HH24:MI')       AS hour,
      p.run_seconds,
      p.idle_seconds,
      COALESCE(p.manual_seconds, 0)                                              AS manual_seconds,
      GREATEST(0, 3600 - p.run_seconds - p.idle_seconds)                        AS off_seconds,
      p.produced_qty,
      ROUND(COALESCE(p.energy_kwh, 0)::numeric, 3)                              AS energy_kwh
    FROM production_hourly p
    JOIN machines m ON m.id = p.machine_id
    LEFT JOIN shifts   s    ON s.id = p.shift_id
    LEFT JOIN op_map   op   ON op.machine_id = p.machine_id
    WHERE m.company_id = $1
      AND CASE
            WHEN s.start_time IS NOT NULL
             AND (p.hour_start AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time
            THEN DATE(p.hour_start AT TIME ZONE 'Asia/Kolkata')
            WHEN s.start_time IS NOT NULL
            THEN DATE(p.hour_start AT TIME ZONE 'Asia/Kolkata') - 1
            ELSE DATE(p.hour_start AT TIME ZONE 'Asia/Kolkata')
          END BETWEEN $2::date AND $3::date
      ${extra}
    ORDER BY m.machine_serial_no, p.hour_start
  `, params);

  const totalParts  = rows.reduce((a, r) => a + Number(r.produced_qty || 0), 0);
  const totalRunSec = rows.reduce((a, r) => a + Number(r.run_seconds   || 0), 0);
  const totalEnergy = rows.reduce((a, r) => a + Number(r.energy_kwh    || 0), 0);
  const totalSec    = rows.reduce((a, r) => a + Number(r.run_seconds || 0) + Number(r.idle_seconds || 0), 0);
  const efficiency  = totalSec > 0 ? ((totalRunSec / totalSec) * 100).toFixed(1) : '0.0';

  return {
    rows: rows.map(r => ({
      ...r,
      run_time:   secToHHMM(r.run_seconds),
      idle_time:  secToHHMM(r.idle_seconds),
      setup_time: secToHHMM(r.manual_seconds),
      off_time:   secToHHMM(r.off_seconds),
    })),
    summary: {
      total_parts:    totalParts,
      run_hours:      (totalRunSec / 3600).toFixed(2),
      total_energy:   totalEnergy.toFixed(2),
      efficiency_pct: efficiency
    }
  };
};

/* ─────────────────────────────────────────────────────────
   OEE HOURLY REPORT  (JSON)
───────────────────────────────────────────────────────── */

exports.oeeHourlyData = async (company_id, date_from, date_to, machine_id, shift_id, operator_id) => {
  const params = [company_id, date_from, date_to];
  const conds  = [];

  if (machine_id)  { params.push(machine_id);  conds.push(`o.machine_id   = $${params.length}`); }
  if (shift_id)    { params.push(shift_id);    conds.push(`o.shift_id     = $${params.length}`); }
  if (operator_id) { params.push(operator_id); conds.push(`op.operator_id = $${params.length}`); }

  const extra = conds.length ? 'AND ' + conds.join(' AND ') : '';

  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}
    SELECT
      m.machine_serial_no                                                         AS machine,
      COALESCE(op.operator_name, '--')                                            AS operator,
      TO_CHAR(o.hour_start AT TIME ZONE 'Asia/Kolkata', 'DD-Mon HH24:MI')        AS hour,
      ROUND(o.availability::numeric, 2)                                           AS availability,
      ROUND(o.performance::numeric,  2)                                           AS performance,
      ROUND(o.quality::numeric,      2)                                           AS quality,
      ROUND(o.oee::numeric,          2)                                           AS oee
    FROM oee_hourly o
    JOIN machines m ON m.id = o.machine_id
    LEFT JOIN shifts s ON s.id = o.shift_id
    LEFT JOIN op_map op ON op.machine_id = o.machine_id
    WHERE m.company_id = $1
      AND CASE
            WHEN s.start_time IS NOT NULL
             AND (o.hour_start AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time
            THEN DATE(o.hour_start AT TIME ZONE 'Asia/Kolkata')
            WHEN s.start_time IS NOT NULL
            THEN DATE(o.hour_start AT TIME ZONE 'Asia/Kolkata') - 1
            ELSE DATE(o.hour_start AT TIME ZONE 'Asia/Kolkata')
          END BETWEEN $2::date AND $3::date
      ${extra}
    ORDER BY m.machine_serial_no, o.hour_start
  `, params);

  const avg = (field) => rows.length
    ? (rows.reduce((a, r) => a + Number(r[field] || 0), 0) / rows.length).toFixed(1)
    : '0.0';

  return {
    rows,
    summary: {
      avg_availability: avg('availability'),
      avg_performance:  avg('performance'),
      avg_quality:      avg('quality'),
      avg_oee:          avg('oee')
    }
  };
};

/* ─────────────────────────────────────────────────────────
   SHIFT OEE REPORT  (JSON)
───────────────────────────────────────────────────────── */

exports.shiftOeeData = async (company_id, date_from, date_to, machine_id, shift_id, operator_id) => {
  const params = [company_id, date_from, date_to];
  const conds  = [];

  if (machine_id)  { params.push(machine_id);  conds.push(`o.machine_id   = $${params.length}`); }
  if (shift_id)    { params.push(shift_id);    conds.push(`o.shift_id     = $${params.length}`); }
  if (operator_id) { params.push(operator_id); conds.push(`op.operator_id = $${params.length}`); }

  const extra = conds.length ? 'AND ' + conds.join(' AND ') : '';

  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}
    SELECT
      m.machine_serial_no                        AS machine,
      COALESCE(op.operator_name, '--')           AS operator,
      s.shift_code                               AS shift,
      TO_CHAR(o.shift_date, 'DD-Mon-YYYY')       AS date,
      ROUND(o.availability::numeric, 2)          AS availability,
      ROUND(o.performance::numeric,  2)          AS performance,
      ROUND(o.quality::numeric,      2)          AS quality,
      ROUND(o.oee::numeric,          2)          AS oee
    FROM oee_shift_summary o
    JOIN machines m ON m.id = o.machine_id
    JOIN shifts   s ON s.id = o.shift_id
    LEFT JOIN op_map op ON op.machine_id = o.machine_id
    WHERE m.company_id = $1
      AND o.shift_date BETWEEN $2 AND $3
      ${extra}
    ORDER BY o.shift_date DESC, s.shift_code, m.machine_serial_no
  `, params);

  const avg = (field) => rows.length
    ? (rows.reduce((a, r) => a + Number(r[field] || 0), 0) / rows.length).toFixed(1)
    : '0.0';

  return {
    rows,
    summary: {
      avg_availability: avg('availability'),
      avg_performance:  avg('performance'),
      avg_quality:      avg('quality'),
      avg_oee:          avg('oee')
    }
  };
};

/* ─────────────────────────────────────────────────────────
   LEGACY EXCEL helpers
───────────────────────────────────────────────────────── */

exports.hourlyOee = async (company_id, date) => {
  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}
    SELECT
      m.machine_serial_no                                                         AS "Machine",
      COALESCE(op.operator_name, '--')                                            AS "Operator",
      TO_CHAR(o.hour_start AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY HH24:MI')   AS "Hour",
      ROUND(o.availability::numeric, 2)                                           AS "Availability %",
      ROUND(o.performance::numeric,  2)                                           AS "Performance %",
      ROUND(o.quality::numeric,      2)                                           AS "Quality %",
      ROUND(o.oee::numeric,          2)                                           AS "OEE %"
    FROM oee_hourly o
    JOIN machines m ON m.id = o.machine_id
    LEFT JOIN shifts s ON s.id = o.shift_id
    LEFT JOIN op_map op ON op.machine_id = o.machine_id
    WHERE m.company_id = $1
      AND CASE
            WHEN s.start_time IS NOT NULL
             AND (o.hour_start AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time
            THEN DATE(o.hour_start AT TIME ZONE 'Asia/Kolkata')
            WHEN s.start_time IS NOT NULL
            THEN DATE(o.hour_start AT TIME ZONE 'Asia/Kolkata') - 1
            ELSE DATE(o.hour_start AT TIME ZONE 'Asia/Kolkata')
          END = $2::date
    ORDER BY m.machine_serial_no, o.hour_start
  `, [company_id, date]);
  return rows;
};

exports.shiftOee = async (company_id, date) => {
  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}
    SELECT
      m.machine_serial_no                        AS "Machine",
      COALESCE(op.operator_name, '--')           AS "Operator",
      s.shift_code                               AS "Shift",
      TO_CHAR(o.shift_date, 'DD-Mon-YYYY')       AS "Date",
      ROUND(o.availability::numeric, 2)          AS "Availability %",
      ROUND(o.performance::numeric,  2)          AS "Performance %",
      ROUND(o.quality::numeric,      2)          AS "Quality %",
      ROUND(o.oee::numeric,          2)          AS "OEE %"
    FROM oee_shift_summary o
    JOIN machines m ON m.id = o.machine_id
    JOIN shifts   s ON s.id = o.shift_id
    LEFT JOIN op_map op ON op.machine_id = o.machine_id
    WHERE m.company_id = $1
      AND o.shift_date = $2
    ORDER BY s.shift_code, m.machine_serial_no
  `, [company_id, date]);
  return rows;
};

exports.production = async (company_id, date) => {
  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}
    SELECT
      m.machine_serial_no                                                         AS "Machine",
      COALESCE(op.operator_name, '--')                                            AS "Operator",
      COALESCE(s.shift_code, '--')                                                AS "Shift",
      TO_CHAR(p.hour_start AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY HH24:MI')   AS "Hour",
      p.run_seconds                                                                AS "Run Sec",
      p.idle_seconds                                                               AS "Idle Sec",
      COALESCE(p.manual_seconds, 0)                                                AS "Setup Sec",
      GREATEST(0, 3600 - p.run_seconds - p.idle_seconds)                          AS "Off Sec",
      p.produced_qty                                                               AS "Parts Made",
      ROUND(COALESCE(p.energy_kwh, 0)::numeric, 3)                                AS "Energy kWh"
    FROM production_hourly p
    JOIN machines m ON m.id = p.machine_id
    LEFT JOIN shifts   s  ON s.id = p.shift_id
    LEFT JOIN op_map   op ON op.machine_id = p.machine_id
    WHERE m.company_id = $1
      AND CASE
            WHEN s.start_time IS NOT NULL
             AND (p.hour_start AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time
            THEN DATE(p.hour_start AT TIME ZONE 'Asia/Kolkata')
            WHEN s.start_time IS NOT NULL
            THEN DATE(p.hour_start AT TIME ZONE 'Asia/Kolkata') - 1
            ELSE DATE(p.hour_start AT TIME ZONE 'Asia/Kolkata')
          END = $2::date
    ORDER BY m.machine_serial_no, p.hour_start
  `, [company_id, date]);
  return rows;
};
