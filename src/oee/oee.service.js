/**
 * OEE Records — the Reports page's OEE Records tab: one row per machine and
 * completed shift (oee_shift_summary), a page at a time on screen and every
 * row in its CSV / Excel file.
 *
 * The figures and the operator are the Shift OEE report's (report.service
 * shiftOeeData): the same table, the same rounding, the same operator rule,
 * so the two tabs never disagree about a shift.
 */

const db = require('../db');
const { plantSql, sharedEntityPlantSql, entityPlantSql: linePlantSql } = require('../lib/read-scope');
const { OPERATOR_CTE } = require('../reports/operator-map');
const { shapeRows } = require('../reports/report.columns');
const { createExcel } = require('../reports/excel.util');
const { toCsv } = require('../utils/export.util');

const CONTENT_TYPES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv:  'text/csv; charset=utf-8'
};

/* ===============================================
   GET META (Machines, Shifts, Lines)
   =============================================== */
exports.getMeta = async (plantId, companyId) => {

  try {

    if (!companyId) {
      throw new Error('Company ID is required');
    }

    const filterVal = companyId;

    // Get LINES
    const linesQuery = await db.query(`
      SELECT DISTINCT
        l.id,
        l.name
      FROM line l
      WHERE l.company_id = $1${linePlantSql('l', plantId, companyId)}
      ORDER BY l.name ASC
    `, [filterVal]);

    // Get MACHINES
    const machinesQuery = await db.query(`
      SELECT
        m.id,
        m.machine_serial_no,
        m.line_id,
        l.name as line_name
      FROM machines m
      LEFT JOIN line l ON l.id = m.line_id
      WHERE m.company_id = $1 AND m.is_active = TRUE${plantSql('m.id', plantId, companyId)}
      ORDER BY m.machine_serial_no ASC
    `, [filterVal]);

    // Get SHIFTS
    const shiftsQuery = await db.query(`
      SELECT
        s.id,
        s.shift_code,
        s.shift_name,
        s.start_time,
        s.end_time
      FROM shifts s
      WHERE s.company_id = $1 AND s.is_active = TRUE${sharedEntityPlantSql('s', plantId, companyId)}
      ORDER BY s.start_time ASC
    `, [filterVal]);

    return {
      lines: linesQuery.rows,
      machines: machinesQuery.rows,
      shifts: shiftsQuery.rows
    };

  } catch (err) {
    console.error('❌ getMeta error:', err.message);
    throw err;
  }

};

/* ===============================================
   RECORDS — the table and its file
   =============================================== */

/** The table's columns, in its order and under its headings: the file writes the same. */
const COLUMNS = [
  { key: 'shift_date',        label: 'Date' },
  { key: 'machine_serial_no', label: 'Machine' },
  { key: 'shift_code',        label: 'Shift' },
  { key: 'operator_name',     label: 'Operator' },
  { key: 'oee',               label: 'OEE (%)',          numeric: true },
  { key: 'availability',      label: 'Availability (%)', numeric: true },
  { key: 'performance',       label: 'Performance (%)',  numeric: true },
  { key: 'quality',           label: 'Quality (%)',      numeric: true }
];

/** The columns the table sorts by, and what each sorts on. */
const SORTS = {
  shift_date:        'os.shift_date',
  machine_serial_no: 'm.machine_serial_no',
  shift_code:        's.shift_code',
  oee:               'os.oee',
  availability:      'os.availability',
  performance:       'os.performance',
  quality:           'os.quality'
};

/** A year of shifts at most; each row is a machine's shift, not an hour. */
const MAX_EXPORT_DAYS = 366;
/** The most a file holds, even emailed: past this it would not open well, and building it would hold the server. */
const MAX_EXPORT_ROWS = 250000;

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function day(value, name) {
  const v = String(value ?? '');
  const d = new Date(`${v}T00:00:00Z`);
  if (!ISO_DAY.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw fail(400, 'INVALID_DATE', `${name} must be a date in YYYY-MM-DD form`);
  }
  return d;
}

/** An optional id filter: absent, or a positive whole number. */
function id(query, name) {
  const v = query[name];
  if (v === undefined || v === null || v === '' || v === 'null') return null;
  if (!/^[1-9]\d{0,9}$/.test(String(v))) throw fail(400, 'INVALID_FILTER', `${name} must be a positive whole number`);
  return Number(v);
}

/**
 * The WHERE both the page and the file read, so they hold the same records.
 * The company always; a line, machine, shift, date range and search when
 * given. A malformed filter is refused (400) rather than handed to SQL.
 */
function filtersOf(query, plantId, companyId, { rangeRequired = false } = {}) {
  const params = [companyId];
  const where = ['m.company_id = $1'];

  const line = id(query, 'line_id'), machine = id(query, 'machine_id'), shift = id(query, 'shift_id');
  if (line)    where.push(`m.line_id = $${params.push(line)}`);
  if (machine) where.push(`os.machine_id = $${params.push(machine)}`);
  if (shift)   where.push(`os.shift_id = $${params.push(shift)}`);

  let days = null;
  const { from_date, to_date } = query;
  if (rangeRequired || from_date || to_date) {
    const from = day(from_date, 'from_date'), to = day(to_date, 'to_date');
    if (to < from) throw fail(400, 'INVALID_RANGE', 'to_date falls before from_date');
    days = Math.round((to - from) / 86_400_000) + 1;
    where.push(`os.shift_date BETWEEN $${params.push(from_date)}::date AND $${params.push(to_date)}::date`);
  }

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const p = params.push(`%${search}%`);
    where.push(`(m.machine_serial_no ILIKE $${p} OR s.shift_code ILIKE $${p})`);
  }

  return { sql: `WHERE ${where.join(' AND ')}${plantSql('m.id', plantId, companyId)}`, params, days };
}

/**
 * ORDER BY: the column asked for — unknown values last, either way — then a
 * fixed order, so a page never repeats or skips a row between requests.
 * (The unique key is machine, shift, date.)
 */
function orderOf(query) {
  const column = Object.prototype.hasOwnProperty.call(SORTS, query.sort_by) ? SORTS[query.sort_by] : SORTS.shift_date;
  const dir = String(query.sort_order || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  return `ORDER BY ${column} ${dir} NULLS LAST, os.shift_date DESC, m.machine_serial_no ASC, s.start_time ASC, os.machine_id, os.shift_id`;
}

/** One row per machine and shift: the date as YYYY-MM-DD (no time zone to shift it), figures to 2 places. */
const RECORD_SQL = (where, order) => `
  WITH ${OPERATOR_CTE}
  SELECT
    TO_CHAR(os.shift_date, 'YYYY-MM-DD')        AS shift_date,
    m.id                                        AS machine_id,
    m.machine_serial_no,
    s.shift_code,
    s.shift_name,
    op.operator_name,
    ROUND(os.oee::numeric, 2)                   AS oee,
    ROUND(os.availability::numeric, 2)          AS availability,
    ROUND(os.performance::numeric, 2)           AS performance,
    ROUND(os.quality::numeric, 2)               AS quality
  FROM oee_shift_summary os
  JOIN machines m ON m.id = os.machine_id
  JOIN shifts   s ON s.id = os.shift_id
  LEFT JOIN op_map op ON op.machine_id = os.machine_id
  ${where}
  ${order}
`;

/* ===============================================
   GET REPORTS — a page of records
   GET /oee/reports?from_date=&to_date=&line_id=&machine_id=&shift_id=&page=&limit=&sort_by=&sort_order=
   =============================================== */
exports.getReports = async (query, plantId, companyId) => {
  const pageNum = Math.max(1, parseInt(query.page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  const offset = (pageNum - 1) * limitNum;

  const f = filtersOf(query, plantId, companyId);

  const countResult = await db.query(`
    SELECT COUNT(*) AS total
    FROM oee_shift_summary os
    JOIN machines m ON m.id = os.machine_id
    JOIN shifts   s ON s.id = os.shift_id
    ${f.sql}
  `, f.params);
  const total = parseInt(countResult.rows[0]?.total || 0, 10);

  const params = [...f.params];
  const page = `LIMIT $${params.push(limitNum)} OFFSET $${params.push(offset)}`;
  const { rows } = await db.query(`${RECORD_SQL(f.sql, orderOf(query))} ${page}`, params);

  return {
    data: rows,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    filters: {
      line_id: query.line_id, machine_id: query.machine_id, shift_id: query.shift_id,
      from_date: query.from_date, to_date: query.to_date, search: query.search
    }
  };
};

/* ===============================================
   EXPORT — every record for these filters, as CSV or Excel
   GET /oee/export?format=csv|xlsx&from_date=&to_date=&…&columns=a,b&sort_by=&sort_order=
   A small export is downloaded; a large one is built in the background and
   emailed (oee.controller → report.mailer).
   =============================================== */

/** The columns asked for (?columns=a,b), in the table's order; none asked: all of them. */
function columnsOf(asked) {
  const keys = (Array.isArray(asked) ? asked : String(asked ?? '').split(','))
    .map(k => String(k).trim()).filter(Boolean);
  if (!keys.length) return COLUMNS;
  const unknown = keys.filter(k => !COLUMNS.some(c => c.key === k));
  if (unknown.length) throw fail(400, 'UNKNOWN_COLUMN', `Not a column of OEE Records: ${unknown.join(', ')}`);
  return COLUMNS.filter(c => keys.includes(c.key));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-10-21 → 21-Oct-2026, as the Shift OEE report writes a date. */
const dayLabel = iso => (ISO_DAY.test(iso || '') ? `${iso.slice(8, 10)}-${MONTHS[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : iso);

/**
 * What an export asks for, checked before anything is read or answered:
 * the columns, the filters, a range of at most a year, and the order.
 */
exports.exportPlan = (query, plantId, companyId) => {
  const columns = columnsOf(query.columns);
  const f = filtersOf(query, plantId, companyId, { rangeRequired: true });
  if (f.days > MAX_EXPORT_DAYS) {
    throw fail(413, 'RANGE_TOO_LARGE',
      `This range covers ${f.days} days. Up to ${MAX_EXPORT_DAYS} days can be exported at once; choose a shorter range.`,
      { days: f.days, max_days: MAX_EXPORT_DAYS });
  }
  return {
    columns, where: f, order: orderOf(query), days: f.days,
    from: query.from_date, to: query.to_date,
    filters: { line_id: id(query, 'line_id'), machine_id: id(query, 'machine_id'), shift_id: id(query, 'shift_id') }
  };
};

/** The plan's records in the table's order, at most `limit`. */
exports.planRows = async (plan, limit) => {
  const params = [...plan.where.params];
  const { rows } = await db.query(`${RECORD_SQL(plan.where.sql, plan.order)} LIMIT $${params.push(limit)}`, params);
  return rows;
};

/** How many records the plan holds — for the "this report is large (n rows)" message. */
exports.planCount = async plan => {
  const { rows } = await db.query(`
    SELECT COUNT(*) AS total
    FROM oee_shift_summary os
    JOIN machines m ON m.id = os.machine_id
    JOIN shifts   s ON s.id = os.shift_id
    ${plan.where.sql}
  `, plan.where.params);
  return parseInt(rows[0]?.total || 0, 10);
};

/**
 * The file: the table's columns under its headings, a date as 21-Oct-2026,
 * figures as numbers. `rows`: already read; otherwise read here (the
 * background build of a large export), up to MAX_EXPORT_ROWS.
 */
exports.buildFile = async (plan, format, rows = null) => {
  const data = rows || await exports.planRows(plan, MAX_EXPORT_ROWS + 1);
  if (data.length > MAX_EXPORT_ROWS) {
    throw fail(413, 'TOO_MANY_ROWS',
      `More than ${MAX_EXPORT_ROWS.toLocaleString('en-IN')} records match. Choose a shorter range, a line or a machine.`);
  }
  const readable = data.map(r => ({ ...r, shift_date: dayLabel(r.shift_date), operator_name: r.operator_name || '--' }));
  const shaped = shapeRows(readable, plan.columns);
  const labels = plan.columns.map(c => c.label);
  return {
    body: format === 'csv' ? toCsv(shaped, labels) : await createExcel('OEE Records', shaped, labels),
    rows: data.length,
    columnLabels: labels,
    contentType: CONTENT_TYPES[format],
    filename: `oee-records_${plan.from}_to_${plan.to}.${format}`
  };
};

exports.COLUMNS = COLUMNS;
exports.MAX_EXPORT_DAYS = MAX_EXPORT_DAYS;
exports.MAX_EXPORT_ROWS = MAX_EXPORT_ROWS;
