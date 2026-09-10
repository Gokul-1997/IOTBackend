/**
 * Shared table export: CSV and PDF.
 *
 * Lifted out of dashboard.controller once a second module needed it. Two
 * copies of an export would drift, and the first sign of that is a report
 * that says one thing in Excel and another in PDF.
 *
 * Excel goes through reports/excel.util, which already existed.
 */

const PDFDocument = require('pdfkit');

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

/**
 * A printable table, streamed so a large export never buffers in memory.
 *
 * @param {object}   res      the response to stream into
 * @param {string}   title
 * @param {object[]} rows     already formatted for display
 * @param {string[]} headers  column order; each must be a key of every row
 * @param {number[]} widths   column widths in points
 */
function tablePdf(res, title, rows, headers, widths) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text(title, { align: 'left' });
  doc.fontSize(9).fillColor('#555')
     .text(`Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — ${rows.length} record(s)`);
  doc.moveDown(0.8).fillColor('#000');

  const left = doc.page.margins.left;
  const width = widths.reduce((a, b) => a + b, 0);

  const line = (cells, bold) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    let x = left;
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ''), x, y, { width: widths[i] - 6, ellipsis: true, lineBreak: false });
      x += widths[i];
    });
    doc.y = y + 14;
  };

  const rule = () => doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3).strokeColor('#ccc').stroke();

  line(headers, true);
  rule();

  for (const r of rows) {
    // Break the page before writing, never after — writing first leaves a
    // clipped half-row at the bottom.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      line(headers, true);
      rule();
    }
    line(headers.map(h => r[h]));
  }

  doc.end();
}

module.exports = { toCsv, tablePdf };
