/**
 * OEE REPORTS CONTROLLER
 */

const OeeService = require('./oee.service');

/* ===============================================
   GET META (Machines, Shifts, Lines)
   GET /oee/meta
   =============================================== */
exports.getMeta = async (req, res) => {

  try {

    const data = await OeeService.getMeta(req.user.plant_id);

    return res.json({
      status: 'success',
      data
    });

  } catch (err) {

    console.error('❌ getMeta error:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Failed to load metadata'
    });

  }

};

/* ===============================================
   GET REPORTS
   GET /oee/reports?machine_id=1&shift_id=1&page=1
   =============================================== */
exports.getReports = async (req, res) => {

  try {

    const result = await OeeService.getReports(req.query, req.user.plant_id);

    return res.json({
      status: 'success',
      ...result
    });

  } catch (err) {

    console.error('❌ getReports error:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Failed to load reports'
    });

  }

};

/* ===============================================
   EXPORT CSV
   GET /oee/export?machine_id=1&shift_id=1
   =============================================== */
exports.exportCSV = async (req, res) => {

  try {

    const result = await OeeService.exportCSV(req.query, req.user.plant_id);

    // Set CSV headers
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);

    // Generate CSV
    const headers = ['Date', 'Machine', 'Shift', 'Operator', 'OEE', 'Availability', 'Performance', 'Quality'];
    let csv = headers.join(',') + '\n';

    for (const row of result.data) {
      csv += `${row.shift_date},${row.machine_serial_no},${row.shift_code},${row.operator_name || '--'},${row.oee},${row.availability},${row.performance},${row.quality}\n`;
    }

    return res.send(csv);

  } catch (err) {

    console.error('❌ exportCSV error:', err);

    return res.status(500).json({
      status: 'error',
      message: 'Failed to export CSV'
    });

  }

};