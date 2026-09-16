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

exports.getOperators = async (company_id, machine_id) => {
  const params = [company_id];
  const machineFilter = machine_id
    ? `AND oma.machine_id = $${params.push(machine_id)}`
    : '';

  const { rows } = await db.query(
    `SELECT DISTINCT o.id, o.operator_name AS name
     FROM operators o
     JOIN operator_machine_assignments oma ON oma.operator_id = o.id AND oma.is_active = TRUE
     JOIN machines m ON m.id = oma.machine_id AND m.company_id = $1 AND m.is_active = TRUE
     WHERE o.is_active = TRUE
     ${machineFilter}
     ORDER BY o.operator_name`,
    params
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
      AND (
        s.start_time IS NULL
        OR (
          p.hour_start >= ($2::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
          AND p.hour_start < (
                CASE WHEN s.start_time > s.end_time
                     THEN ($3::date + INTERVAL '1 day' + s.end_time)
                     ELSE ($3::date + s.end_time)
                END
              ) AT TIME ZONE 'Asia/Kolkata'
        )
      )
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
      AND (
        s.start_time IS NULL
        OR (
          o.hour_start >= ($2::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
          AND o.hour_start < (
                CASE WHEN s.start_time > s.end_time
                     THEN ($3::date + INTERVAL '1 day' + s.end_time)
                     ELSE ($3::date + s.end_time)
                END
              ) AT TIME ZONE 'Asia/Kolkata'
        )
      )
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
      AND (
        s.start_time IS NULL
        OR (
          o.hour_start >= ($2::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
          AND o.hour_start < (
                CASE WHEN s.start_time > s.end_time
                     THEN ($2::date + INTERVAL '1 day' + s.end_time)
                     ELSE ($2::date + s.end_time)
                END
              ) AT TIME ZONE 'Asia/Kolkata'
        )
      )
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
      AND (
        s.start_time IS NULL
        OR (
          p.hour_start >= ($2::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
          AND p.hour_start < (
                CASE WHEN s.start_time > s.end_time
                     THEN ($2::date + INTERVAL '1 day' + s.end_time)
                     ELSE ($2::date + s.end_time)
                END
              ) AT TIME ZONE 'Asia/Kolkata'
        )
      )
    ORDER BY m.machine_serial_no, p.hour_start
  `, [company_id, date]);
  return rows;
};


/* ─────────────────────────────────────────────────────────────
   Emailed reports

   A range longer than three months is not answered in the response (see
   report.limits.js); it is built here and sent as a spreadsheet instead.
───────────────────────────────────────────────────────────── */

const { createExcel }       = require('./excel.util');
const { sendEmail }         = require('../utils/nodemailer');
const { resolveColumns, shapeRows, assertType } = require('./report.columns');
const generateReportTemplate = require('../utils/nodemailer/emailTemplates/generateReportTemplate');

const REPORT_NAMES = {
  'production': 'Production Report',
  'oee-hourly': 'Hourly OEE Report',
  'shift-oee':  'Shift OEE Report'
};

/** The dataset behind each report type — the same queries the screen uses. */
async function fetchRows(type, company_id, f) {
  const args = [company_id, f.date_from, f.date_to, f.machine_id || null, f.shift_id || null, f.operator_id || null];
  if (type === 'production') return exports.productionData(...args);
  if (type === 'oee-hourly') return exports.oeeHourlyData(...args);
  return exports.shiftOeeData(...args);
}

/**
 * Build the report and email it.
 *
 * Returns what was sent rather than nothing, so the caller can log it and
 * the tests can assert on it without reaching into nodemailer.
 */
exports.emailReport = async ({ company_id, type, filters, columns, to, requestedBy, labelFor = {} }) => {
  assertType(type);

  const cols = resolveColumns(type, columns);
  const { rows } = await fetchRows(type, company_id, filters);
  const shaped = shapeRows(rows, cols);

  const name = REPORT_NAMES[type];
  const file = `${type}_${filters.date_from}_to_${filters.date_to}.xlsx`;
  const buffer = createExcel(name.slice(0, 31), shaped);

  const filterLines = [];
  if (filters.machine_id)  filterLines.push(`Machine: ${labelFor.machine  || filters.machine_id}`);
  if (filters.shift_id)    filterLines.push(`Shift: ${labelFor.shift      || filters.shift_id}`);
  if (filters.operator_id) filterLines.push(`Operator: ${labelFor.operator || filters.operator_id}`);

  await sendEmail({
    to,
    subject: `${name} — ${filters.date_from} to ${filters.date_to}`,
    html: generateReportTemplate({
      reportName: name,
      dateFrom: filters.date_from,
      dateTo: filters.date_to,
      rowCount: rows.length,
      columnLabels: cols.map(c => c.label),
      filterLines,
      requestedBy
    }),
    text: `${name} for ${filters.date_from} to ${filters.date_to}. ${rows.length} rows attached.`,
    attachments: [{ filename: file, content: buffer }]
  });

  return { rows: rows.length, columns: cols.map(c => c.key), filename: file, to };
};

/* The auth middleware builds req.user without an email — it selects id,
   username, plant_id, company_id and user_type only — so the recipient of an
   emailed report is looked up rather than assumed. */
exports.getUserEmail = async (user_id) => {
  const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [user_id]);
  return rows[0]?.email || null;
};
