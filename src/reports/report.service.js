const db = require('../db');
const { plantSql, sharedEntityPlantSql } = require('../lib/read-scope');

/* ─── helpers ─── */

function secToHHMM(sec) {
  sec = Number(sec || 0);
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  return `${h}:${m}`;
}

/* ─── the operator a row names: one rule for every report (operator-map.js) ─── */
const { OPERATOR_CTE } = require('./operator-map');

/* ─────────────────────────────────────────────────────────
   DROPDOWNS
───────────────────────────────────────────────────────── */

exports.getMachines = async (company_id) => {
  const { rows } = await db.query(
    `SELECT id, machine_serial_no AS name
     FROM machines
     WHERE company_id = $1 AND is_active = TRUE${plantSql('id')}
     ORDER BY machine_serial_no`,
    [company_id]
  );
  return rows;
};

exports.getShifts = async (company_id) => {
  const { rows } = await db.query(
    `SELECT id, shift_code AS name
     FROM shifts
     WHERE company_id = $1 AND is_active = TRUE${sharedEntityPlantSql('shifts')}
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
     JOIN machines m ON m.id = oma.machine_id AND m.company_id = $1 AND m.is_active = TRUE${plantSql('m.id')}
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
  const asOf = `$${params.push(new Date().toISOString())}::timestamptz`;

  const { rows } = await db.query(`
    WITH ${OPERATOR_CTE}, report_clock AS (SELECT ${asOf} AS as_of)
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
    CROSS JOIN report_clock clock
    LEFT JOIN shifts   s    ON s.id = p.shift_id AND s.company_id = $1
    LEFT JOIN op_map   op   ON op.machine_id = p.machine_id
    WHERE m.company_id = $1 AND p.company_id = $1${plantSql('m.id')}${sharedEntityPlantSql('s')}
      /* Bound the rollup scan before resolving each shift's start date.
         Include the first partial clock hour, but never future buckets. */
      AND p.hour_start >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 hour'
      AND p.hour_start < LEAST((($3::date + 2)::timestamp AT TIME ZONE 'Asia/Kolkata'), clock.as_of)
      AND (
        (s.start_time IS NULL
          AND p.hour_start >= $2::date::timestamp AT TIME ZONE 'Asia/Kolkata'
          AND p.hour_start < ($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
        OR (
          s.start_time IS NOT NULL
          AND p.hour_start + INTERVAL '1 hour' > ($2::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
          AND p.hour_start < (
                CASE WHEN s.start_time >= s.end_time
                     THEN ($3::date + INTERVAL '1 day' + s.end_time)
                     ELSE ($3::date + s.end_time)
                END
              ) AT TIME ZONE 'Asia/Kolkata'
          /* A preloaded 20:00 bucket must not show a 20:30 shift at 20:15.
             This also holds when the selected range starts before today. */
          AND (
            ((clock.as_of AT TIME ZONE 'Asia/Kolkata')::date + s.start_time) AT TIME ZONE 'Asia/Kolkata' <= clock.as_of
            OR p.hour_start + INTERVAL '1 hour' <=
              ((clock.as_of AT TIME ZONE 'Asia/Kolkata')::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
          )
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
    WHERE m.company_id = $1${plantSql('m.id')}
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
    WHERE m.company_id = $1${plantSql('m.id')}
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

/* ─────────────────────────────────────────────────────────────
   Files — the Excel / CSV of a report

   One file for the screen's report: its dates, machine, shift and operator,
   the columns chosen and the order sorted. Downloaded when it is small;
   built in the background and emailed when it is large (report.mailer.js).
───────────────────────────────────────────────────────────── */

const { createExcel }       = require('./excel.util');
const { toCsv }             = require('../utils/export.util');
const { resolveColumns, shapeRows, sortRows, assertType } = require('./report.columns');

const REPORT_NAMES = {
  'production': 'Production Report',
  'oee-hourly': 'Hourly OEE Report',
  'shift-oee':  'Shift OEE Report'
};
exports.REPORT_NAMES = REPORT_NAMES;

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv:  'text/csv; charset=utf-8'
};
exports.CONTENT_TYPES = CONTENT_TYPES;

/** The dataset behind each report type — the same queries the screen uses. */
async function fetchRows(type, company_id, f) {
  const args = [company_id, f.date_from, f.date_to, f.machine_id || null, f.shift_id || null, f.operator_id || null];
  if (type === 'production') return exports.productionData(...args);
  if (type === 'oee-hourly') return exports.oeeHourlyData(...args);
  return exports.shiftOeeData(...args);
}

/** The report's rows, as the screen reads them. */
exports.reportRows = async (type, company_id, filters) => (await fetchRows(type, company_id, filters)).rows;

/**
 * The report as a file. `rows`: already read (a download measured first);
 * otherwise read here — in the background, for a report too long to read
 * while the person waits. (The Excel download used to be the first day only,
 * every machine and every column, whatever the screen showed.)
 */
exports.buildFile = async ({ company_id, type, format = 'xlsx', filters, columns, sort, dir, rows = null }) => {
  assertType(type);
  const cols = resolveColumns(type, columns);
  const data = rows || await exports.reportRows(type, company_id, filters);
  const shaped = shapeRows(sortRows(data, type, sort, dir), cols);
  const labels = cols.map(c => c.label);
  const body = format === 'csv'
    ? toCsv(shaped, labels)
    : await createExcel(REPORT_NAMES[type].slice(0, 31), shaped, labels);
  return {
    body, rows: data.length, columnLabels: labels, contentType: CONTENT_TYPES[format],
    filename: `${type}_${filters.date_from}_to_${filters.date_to}.${format}`
  };
};
