/**
 * Shared table export: CSV. (The PDF exports were taken out, 2026-10-14.)
 *
 * Lifted out of dashboard.controller once a second module needed it. Two
 * copies of an export would drift, and the first sign of that is a report
 * that says one thing in Excel and another in CSV.
 *
 * Excel goes through reports/excel.util, which already existed.
 */

/**
 * Minimal RFC 4180 CSV.
 *
 * Quoting is not optional: machine serials, company names and task titles
 * all contain commas, and an unquoted value with one shifts every later
 * column on that row — a corruption that looks like clean data when opened.
 */
function toCsv(rows, headerOrder = null) {
  // the report's own headings when given, so an empty report still has its header row
  const headers = headerOrder || (rows.length ? Object.keys(rows[0]) : []);
  if (!headers.length) return '';
  const cell = v => {
    const s = asText(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(','), ...rows.map(r => headers.map(h => cell(r[h])).join(','))].join('\r\n');
}

/*
 * A cell a spreadsheet would run as a formula — starting =, +, -, @, a tab or
 * a carriage return — is written with a leading apostrophe so it opens as the
 * text it is ("CSV injection", OWASP). Machine, operator and alarm names are
 * typed by people; "=HYPERLINK(…)" in one must not become a live link in the
 * plant manager's spreadsheet. A number stays a number: -5 is a value.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;
function asText(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

module.exports = { toCsv };
