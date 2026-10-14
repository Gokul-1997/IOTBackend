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
function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => cell(r[h])).join(','))].join('\r\n');
}

module.exports = { toCsv };
