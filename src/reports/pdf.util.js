const PDFDocument = require('pdfkit');
const path = require('node:path');

const FONT = path.join(__dirname, 'fonts/NotoSansTamil.ttf');
const MARGIN = 36;
const FONT_SIZE = 8;
const LINE = 13;
const PAD = 6;
const MAX_COLUMNS = 7;
const MAX_PDF_ROWS = 5000;
const tooLarge = () => Object.assign(new Error('This PDF is too large. Choose fewer dates or machines, or export Excel or CSV.'),
  { status: 413, code: 'PDF_REPORT_TOO_LARGE' });

const text = value => value == null ? '' : String(value)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[\u2010-\u2015]/g, '-');

/** Wrap by measured width, including long program names and unbroken identifiers. */
function wrap(doc, value, width) {
  const lines = [];
  for (const paragraph of text(value).split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && doc.widthOfString(`${line} ${word}`) <= width) { line += ` ${word}`; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const ch of word) {
        if (line && doc.widthOfString(line + ch) > width) { lines.push(line); line = ''; }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

/**
 * A printable A4 table. Every row/column is retained, with repeated headings,
 * numbered pages, wrapped cells and continuation pages for very long notes.
 * Wide reports use column sections with a repeated row number and first column.
 * No browser, external service, or live database connection is needed to build it.
 */
async function createPdf(title, rows, headers = null, { subtitle = '', generatedAt = new Date() } = {}) {
  if (rows.length > MAX_PDF_ROWS) throw tooLarge();
  const labels = headers || (rows.length ? Object.keys(rows[0]) : []);
  const groups = [];
  if (labels.length <= MAX_COLUMNS) groups.push(labels);
  else {
    for (let n = 1; n < labels.length; n += MAX_COLUMNS - 1) groups.push([labels[0], ...labels.slice(n, n + MAX_COLUMNS - 1)]);
  }
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, size: 'A4',
    layout: labels.length > 4 ? 'landscape' : 'portrait', margin: MARGIN,
    info: { Title: text(title), Author: 'MEXA', Subject: text(subtitle), CreationDate: generatedAt } });
  doc.registerFont('Report', FONT);
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  try {
    for (let section = 0; section < groups.length; section++) {
      const columns = groups[section];
      let widths, y, bottom;
      const newPage = () => {
        if (doc.bufferedPageRange().count >= 500) throw tooLarge();
        doc.addPage();
        const width = doc.page.width - MARGIN * 2;
        bottom = doc.page.height - MARGIN - 22;
        doc.font('Helvetica-Bold').fontSize(17).fillColor('#142d47');
        const titleLines = wrap(doc, title, width);
        titleLines.forEach((s, i) => doc.text(s, MARGIN, MARGIN + i * 21, { lineBreak: false }));
        y = MARGIN + titleLines.length * 21 + 7;
        doc.font('Report').fontSize(8).fillColor('#516174');
        const context = [subtitle, `${rows.length.toLocaleString('en-IN')} records`,
          ...(groups.length > 1 ? [`Column section ${section + 1} of ${groups.length}`] : [])].filter(Boolean).join(' | ');
        const meta = wrap(doc, context, width);
        meta.forEach((s, i) => doc.text(s, MARGIN, y + i * LINE, { lineBreak: false }));
        y += meta.length * LINE + 14;
        const indexWidth = 33;
        const cellWidth = columns.length ? (width - indexWidth) / columns.length : width - indexWidth;
        widths = [indexWidth, ...columns.map(() => cellWidth)];
        doc.font('Helvetica-Bold').fontSize(FONT_SIZE);
        const heads = ['#', ...columns].map((s, i) => wrap(doc, s, widths[i] - PAD * 2));
        const height = Math.max(1, ...heads.map(a => a.length)) * LINE + PAD * 2;
        doc.rect(MARGIN, y, width, height).fill('#173b5c');
        let x = MARGIN;
        heads.forEach((lines, i) => {
          doc.fillColor('#ffffff');
          lines.forEach((s, j) => doc.text(s, x + PAD, y + PAD + j * LINE, { lineBreak: false }));
          x += widths[i];
        });
        y += height;
        doc.font('Report').fontSize(FONT_SIZE).fillColor('#182c40');
      };
      newPage();
      if (!rows.length) doc.text('No records match these filters.', MARGIN + PAD, y + 15);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const cells = [String(rowIndex + 1), ...columns.map(key => rows[rowIndex][key])]
          .map((v, i) => wrap(doc, v, widths[i] - PAD * 2));
        let offset = 0;
        const length = Math.max(1, ...cells.map(a => a.length));
        while (offset < length) {
          let capacity = Math.floor((bottom - y - PAD * 2) / LINE);
          if (capacity < 1 || (offset === 0 && length > capacity && length * LINE + PAD * 2 < bottom / 2)) {
            newPage(); capacity = Math.floor((bottom - y - PAD * 2) / LINE);
          }
          const take = Math.min(length - offset, capacity);
          const height = take * LINE + PAD * 2;
          const width = widths.reduce((a, b) => a + b, 0);
          if (rowIndex % 2 === 0) doc.rect(MARGIN, y, width, height).fill('#f0f4f8');
          doc.fillColor('#182c40');
          let x = MARGIN;
          cells.forEach((lines, i) => {
            // Repeat the row number on continuation pages to keep long notes traceable.
            const part = i === 0 && offset > 0 ? [String(rowIndex + 1)] : lines.slice(offset, offset + take);
            part.forEach((s, j) => doc.text(s, x + PAD, y + PAD + j * LINE, { lineBreak: false }));
            x += widths[i];
          });
          doc.moveTo(MARGIN, y + height).lineTo(MARGIN + width, y + height).lineWidth(0.3).strokeColor('#d4dee8').stroke();
          y += height; offset += take;
          if (offset < length) newPage();
        }
      }
    }
    const { start, count } = doc.bufferedPageRange();
    const stamp = generatedAt.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    for (let page = start; page < start + count; page++) {
      doc.switchToPage(page);
      const y = doc.page.height - MARGIN;
      doc.font('Helvetica').fontSize(8).fillColor('#516174');
      doc.text(`MEXA | Generated ${stamp} IST`, MARGIN, y, { lineBreak: false });
      const label = `Page ${page + 1} of ${count}`;
      doc.text(label, doc.page.width - MARGIN - doc.widthOfString(label), y, { lineBreak: false });
    }
    doc.end();
  } catch (err) { doc.destroy(err); }
  return result;
}

module.exports = { createPdf, MAX_PDF_ROWS };
