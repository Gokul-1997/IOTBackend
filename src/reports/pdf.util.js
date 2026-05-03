const PDFDocument = require('pdfkit');

exports.generateOEEPdf = (data, filters) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      // Header
      doc.fontSize(18).font('Helvetica-Bold').text('OEE Report', { align: 'center' });
      doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      if (filters?.from_date || filters?.to_date) {
        doc.text(`Period: ${filters.from_date || 'All'} — ${filters.to_date || 'All'}`, { align: 'center' });
      }
      doc.moveDown();

      // Table headers
      const cols = [
        { label: 'Date',       width: 80 },
        { label: 'Machine',    width: 90 },
        { label: 'Shift',      width: 70 },
        { label: 'Operator',   width: 90 },
        { label: 'OEE %',      width: 55 },
        { label: 'Avail %',    width: 55 },
        { label: 'Perf %',     width: 55 },
        { label: 'Quality %',  width: 60 },
      ];

      const startX = 40;
      let y = doc.y;

      // Header row background
      doc.rect(startX, y, cols.reduce((a,c) => a + c.width, 0), 20).fill('#1e40af');
      doc.fill('white').font('Helvetica-Bold').fontSize(9);

      let x = startX;
      for (const col of cols) {
        doc.text(col.label, x + 3, y + 5, { width: col.width - 6, align: 'center' });
        x += col.width;
      }

      y += 20;
      doc.fill('black').font('Helvetica').fontSize(8);

      // Data rows
      for (let ri = 0; ri < data.length; ri++) {
        const row = data[ri];
        if (y > doc.page.height - 60) { doc.addPage(); y = 40; }

        const bg = ri % 2 === 0 ? '#f8fafc' : 'white';
        doc.rect(startX, y, cols.reduce((a,c) => a + c.width, 0), 18).fill(bg);
        doc.fill('black');

        const cells = [
          row.shift_date ? String(row.shift_date).slice(0,10) : '',
          row.machine_serial_no || '',
          row.shift_code || '',
          row.operator_name || '--',
          `${row.oee || 0}%`,
          `${row.availability || 0}%`,
          `${row.performance || 0}%`,
          `${row.quality || 0}%`,
        ];

        x = startX;
        for (let ci = 0; ci < cols.length; ci++) {
          doc.text(cells[ci], x + 3, y + 4, { width: cols[ci].width - 6, align: 'center' });
          x += cols[ci].width;
        }
        y += 18;
      }

      // Footer
      doc.moveDown();
      doc.fontSize(8).fill('#666').text(`Total Records: ${data.length}`, startX);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

exports.generateMaintenancePdf = (data) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      doc.fontSize(18).font('Helvetica-Bold').text('Maintenance Log Report', { align: 'center' });
      doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown();

      for (const row of data) {
        doc.fontSize(11).font('Helvetica-Bold').text(`${row.title} — ${row.machine_serial_no}`);
        doc.fontSize(9).font('Helvetica')
          .text(`Type: ${row.maintenance_type}  |  Status: ${row.status}`)
          .text(`Started: ${row.started_at ? new Date(row.started_at).toLocaleString() : '--'}`)
          .text(`Technician: ${row.technician_name || '--'}`)
          .text(`Work: ${row.work_performed || '--'}`);
        doc.moveDown(0.5);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#e2e8f0');
        doc.moveDown(0.5);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};
