const db = require('../db');
const { generateOEEPdf, generateMaintenancePdf } = require('./pdf.util');

exports.exportOEEPdf = async (req, res) => {
  try {
    const { from_date, to_date, machine_id, shift_id, line_id } = req.query;
    const company_id = req.user.company_id;

    const conditions = [`m.company_id = $1`];
    const params = [company_id];
    let i = 2;
    if (machine_id) { conditions.push(`os.machine_id = $${i++}`); params.push(machine_id); }
    if (shift_id)   { conditions.push(`os.shift_id = $${i++}`); params.push(shift_id); }
    if (from_date && to_date) {
      conditions.push(`os.shift_date BETWEEN $${i++} AND $${i++}`);
      params.push(from_date, to_date);
    }

    const { rows } = await db.query(
      `SELECT os.shift_date, m.machine_serial_no, s.shift_code,
              (SELECT o.operator_name FROM operators o JOIN operator_machine_assignments oma ON o.id = oma.operator_id WHERE oma.machine_id = m.id AND oma.is_active = TRUE LIMIT 1) as operator_name,
              ROUND(CAST(os.oee AS NUMERIC),2) as oee,
              ROUND(CAST(os.availability AS NUMERIC),2) as availability,
              ROUND(CAST(os.performance AS NUMERIC),2) as performance,
              ROUND(CAST(os.quality AS NUMERIC),2) as quality
       FROM oee_shift_summary os
       JOIN machines m ON m.id = os.machine_id
       LEFT JOIN line l ON l.id = m.line_id
       JOIN shifts s ON s.id = os.shift_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY os.shift_date DESC`,
      params
    );

    const pdfBuffer = await generateOEEPdf(rows, { from_date, to_date });
    const filename = `oee_report_${new Date().toISOString().slice(0,10)}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ success: false, message: 'PDF generation failed' });
  }
};

exports.exportMaintenancePdf = async (req, res) => {
  try {
    const { from_date, to_date, machine_id } = req.query;
    const company_id = req.user.company_id;

    const conditions = [`ml.company_id = $1`];
    const params = [company_id];
    let i = 2;
    if (machine_id) { conditions.push(`ml.machine_id = $${i++}`); params.push(machine_id); }
    if (from_date)  { conditions.push(`ml.started_at >= $${i++}`); params.push(from_date); }
    if (to_date)    { conditions.push(`ml.started_at <= $${i++}`); params.push(to_date); }

    const { rows } = await db.query(
      `SELECT ml.*, m.machine_serial_no
       FROM maintenance_logs ml
       JOIN machines m ON m.id = ml.machine_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ml.started_at DESC`,
      params
    );

    const pdfBuffer = await generateMaintenancePdf(rows);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="maintenance_log_${new Date().toISOString().slice(0,10)}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Maintenance PDF error:', err);
    res.status(500).json({ success: false, message: 'PDF generation failed' });
  }
};
