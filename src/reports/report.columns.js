/*
 * The columns each report may contain — the server's copy of the list.
 *
 * The emailed report is built from column keys the client sends, so the set
 * is whitelisted here rather than trusted: an unknown key would otherwise
 * become a spreadsheet header, and a key naming a field the query did not
 * select would silently produce a column of blanks.
 *
 * Kept in step with COL_DEFS in FrontendIOT reports.ts — same keys, same
 * labels, same defaults, so an emailed report matches what was on screen.
 */

const REPORT_COLUMNS = {
  'production': [
    { key: 'machine',      label: 'Machine',      default: true  },
    { key: 'operator',     label: 'Operator',     default: true  },
    { key: 'shift',        label: 'Shift',        default: true  },
    { key: 'hour',         label: 'Hour',         default: true  },
    { key: 'run_time',     label: 'Run Time',     default: true  },
    { key: 'idle_time',    label: 'Idle Time',    default: true  },
    { key: 'setup_time',   label: 'Setup Time',   default: false },
    { key: 'off_time',     label: 'Off Time',     default: false },
    { key: 'produced_qty', label: 'Parts Made',   default: true, numeric: true },
    { key: 'energy_kwh',   label: 'Energy (kWh)', default: true, numeric: true }
  ],
  'oee-hourly': [
    { key: 'machine',      label: 'Machine',       default: true },
    { key: 'operator',     label: 'Operator',      default: true },
    { key: 'hour',         label: 'Hour',          default: true },
    { key: 'availability', label: 'Availability %', default: true, numeric: true },
    { key: 'performance',  label: 'Performance %', default: true, numeric: true },
    { key: 'quality',      label: 'Quality %',     default: true, numeric: true },
    { key: 'oee',          label: 'OEE %',         default: true, numeric: true }
  ],
  'shift-oee': [
    { key: 'machine',      label: 'Machine',       default: true },
    { key: 'operator',     label: 'Operator',      default: true },
    { key: 'shift',        label: 'Shift',         default: true },
    { key: 'date',         label: 'Date',          default: true },
    { key: 'availability', label: 'Availability %', default: true, numeric: true },
    { key: 'performance',  label: 'Performance %', default: true, numeric: true },
    { key: 'quality',      label: 'Quality %',     default: true, numeric: true },
    { key: 'oee',          label: 'OEE %',         default: true, numeric: true }
  ]
};

const REPORT_TYPES = Object.keys(REPORT_COLUMNS);

function assertType(type) {
  if (!REPORT_COLUMNS[type]) {
    const e = new Error(`Unknown report type "${type}". Expected one of: ${REPORT_TYPES.join(', ')}`);
    e.status = 400; e.code = 'UNKNOWN_REPORT_TYPE';
    throw e;
  }
  return type;
}

/**
 * The columns to write, in the report's own order.
 *
 * Order comes from the definition rather than the request so two people
 * asking for the same columns get identical spreadsheets. An empty or
 * absent selection means the defaults — never "no columns", which would
 * produce a file of empty rows.
 */
function resolveColumns(type, keys) {
  assertType(type);
  const all = REPORT_COLUMNS[type];

  if (!Array.isArray(keys) || keys.length === 0) {
    return all.filter(c => c.default);
  }

  const wanted = new Set(keys.map(String));
  const unknown = [...wanted].filter(k => !all.some(c => c.key === k));
  if (unknown.length) {
    const e = new Error(`Not a column of the ${type} report: ${unknown.join(', ')}`);
    e.status = 400; e.code = 'UNKNOWN_COLUMN';
    throw e;
  }

  const picked = all.filter(c => wanted.has(c.key));
  return picked.length ? picked : all.filter(c => c.default);
}

/**
 * Rows reduced to the chosen columns, keyed by label so the header reads.
 *
 * A numeric column's value becomes a number: Postgres hands ROUND()ed
 * figures over as text ("82.35"), and a spreadsheet keeps text as text — a
 * column of percentages that cannot be summed, sorted or charted.
 */
function shapeRows(rows, columns) {
  return rows.map(row => {
    const out = {};
    for (const c of columns) out[c.label] = cellValue(row[c.key], c);
    return out;
  });
}

function cellValue(v, column) {
  if (v === null || v === undefined) return '';
  if (column.numeric && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/**
 * Rows in the order the table on screen shows them: by one of the report's
 * columns, a number compared as a number and text as text — the comparison
 * reports.ts (sortedRows) makes, so a downloaded file reads in the screen's
 * order. No column: the report's own order.
 */
function sortRows(rows, type, key, dir) {
  if (key === undefined || key === null || key === '') return rows;
  if (!REPORT_COLUMNS[type].some(c => c.key === key)) {
    const e = new Error(`Not a column of the ${type} report: ${key}`);
    e.status = 400; e.code = 'UNKNOWN_COLUMN';
    throw e;
  }
  const sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[key] ?? '', bv = b[key] ?? '';
    const cmp = isNaN(Number(av)) ? String(av).localeCompare(String(bv)) : Number(av) - Number(bv);
    return sign * cmp;
  });
}

module.exports = { REPORT_COLUMNS, REPORT_TYPES, assertType, resolveColumns, shapeRows, sortRows };
