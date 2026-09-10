const svc = require('./dashboard.service');
const factorySvc = require('./factory.service');
const maintenanceSvc = require('./maintenance.service');
const preventiveSvc  = require('./preventive.service');
const pmEngine       = require('../maintenance/pm-engine.service');
const periodicSvc   = require('./periodic.service');
const alarmSvc      = require('./alarm.service');
const downtimeSvc   = require('./downtime.service');
const operatorSvc   = require('./operator.service');
const oeeDashSvc    = require('./oee.dashboard.service');
const energySvc     = require('./energy.service');
const periodicEngine = require('../maintenance/periodic-engine.service');
const excel         = require('../reports/excel.util');
const { toCsv, tablePdf } = require('../utils/export.util');

/* =====================================================
   DASHBOARD (Paginated Machine Cards)
   GET /dashboard?page=1&per_page=6
===================================================== */
exports.dashboard = async (req, res) => {
  try {

    const data = await svc.dashboard(req.user.plant_id, req.user.company_id);

    return res.json({
      status: "success",
      ...data
    });

  } catch (err) {
    console.error("Dashboard Error:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to load dashboard"
    });
  }
};




/* =====================================================
   MACHINE DETAIL
   GET /dashboard/:machine_id/detail
===================================================== */
exports.machineDetail = async (req, res) => {

  try {

    const machineId = parseInt(req.params.machine_id);

    if (!machineId) {
      return res.status(400).json({
        status: "error",
        message: "Invalid machine ID"
      });
    }

    const data = await svc.machineDetail(
      req.user.plant_id,
      machineId,
      req.user.company_id
    );

    return res.json({
      status: "success",
      data
    });

  } catch (err) {

    console.error("Machine Detail Error:", err);

    return res.status(500).json({
      status: "error",
      message: "Failed to load machine detail"
    });

  }

};
/* =====================================================
   FACTORY OVERALL DASHBOARD (Phase 2 · Screen 1)
   GET /dashboard/factory?date=&shift_id=&machine_id=
===================================================== */
/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 9 — Energy Monitoring
   ───────────────────────────────────────────────────────────── */

exports.energy = async (req, res) => {
  try {
    const data = await energySvc.getEnergy({ ...req.query, company_id: req.user.company_id });
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Energy dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.getEnergySettings = async (req, res) => {
  try {
    const data = await energySvc.getSettings(req.user.company_id);
    return res.json({ status: 'success', data });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.saveEnergySettings = async (req, res) => {
  try {
    const data = await energySvc.saveSettings({
      ...req.body, company_id: req.user.company_id, user_id: req.user.id
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.exportEnergy = async (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const rows = await energySvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No machines match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const headers = Object.keys(rows[0]);

    if (format === 'xlsx') {
      const file = excel.createExcel('Energy', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=energy_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=energy_${stamp}.csv`)
        .send(toCsv(rows));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=energy_${stamp}.pdf`);
      // headers are taken from the rows because the cost column carries the
      // configured currency in its name
      return tablePdf(res, 'Energy Report', rows, headers, [100, 80, 90, 75, 80, 90, 70, 60]);
    }
    return res.status(400).json({ status: 'error', message: 'format must be xlsx, csv or pdf' });
  } catch (err) {
    console.error('Energy export error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 8 — OEE Dashboard
   ───────────────────────────────────────────────────────────── */

exports.oeeDashboard = async (req, res) => {
  try {
    const data = await oeeDashSvc.getOee({ ...req.query, company_id: req.user.company_id });
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('OEE dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.exportOee = async (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const rows = await oeeDashSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No machines match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = excel.createExcel('OEE', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=oee_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=oee_${stamp}.csv`)
        .send(toCsv(rows));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=oee_${stamp}.pdf`);
      return tablePdf(res, 'OEE Report', rows,
        ['Machine', 'Status', 'Availability', 'Performance', 'Quality', 'OEE', 'Band',
         'Production', 'Good parts', 'Rejections', 'Downtime', 'Alarms'],
        [85, 60, 70, 70, 55, 50, 50, 60, 60, 60, 60, 45]);
    }
    return res.status(400).json({ status: 'error', message: 'format must be xlsx, csv or pdf' });
  } catch (err) {
    console.error('OEE export error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 7 — Operator Performance
   ───────────────────────────────────────────────────────────── */

exports.operators = async (req, res) => {
  try {
    const data = await operatorSvc.getOperators({ ...req.query, company_id: req.user.company_id });
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Operator dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.exportOperators = async (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const rows = await operatorSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No operators match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = excel.createExcel('Operator Performance', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=operator_performance_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=operator_performance_${stamp}.csv`)
        .send(toCsv(rows));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=operator_performance_${stamp}.pdf`);
      return tablePdf(res, 'Operator Performance', rows,
        ['Operator ID', 'Operator', 'Machines', 'Run time', 'Down time', 'Utilization',
         'Produced', 'Good', 'Rejected', 'Quality rate', 'Alarms', 'OEE'],
        [70, 130, 55, 60, 60, 60, 55, 50, 55, 65, 45, 45]);
    }
    return res.status(400).json({ status: 'error', message: 'format must be xlsx, csv or pdf' });
  } catch (err) {
    console.error('Operator export error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 6 — Downtime Reason Loss Analysis
   ───────────────────────────────────────────────────────────── */

exports.downtime = async (req, res) => {
  try {
    const data = await downtimeSvc.getDowntime({ ...req.query, company_id: req.user.company_id });
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Downtime dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.exportDowntime = async (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const rows = await downtimeSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No downtime records match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = excel.createExcel('Downtime', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=downtime_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=downtime_${stamp}.csv`)
        .send(toCsv(rows));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=downtime_${stamp}.pdf`);
      return tablePdf(res, 'Downtime Analysis', rows,
        ['Machine', 'Shift', 'Start', 'End', 'Duration', 'Reason', 'Category', 'Sub reason', 'Operator', 'Status'],
        [75, 55, 105, 105, 55, 105, 75, 90, 75, 45]);
    }
    return res.status(400).json({ status: 'error', message: 'format must be xlsx, csv or pdf' });
  } catch (err) {
    console.error('Downtime export error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 5 — Alarm Dashboard & Reports
   ───────────────────────────────────────────────────────────── */

exports.alarms = async (req, res) => {
  try {
    const data = await alarmSvc.getAlarms({ ...req.query, company_id: req.user.company_id });
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Alarm dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.exportAlarms = async (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const rows = await alarmSvc.getExportRows({ ...req.query, company_id: req.user.company_id });

    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No alarms match these filters' });
    }

    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = excel.createExcel('Alarms', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=alarms_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=alarms_${stamp}.csv`)
        .send(toCsv(rows));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=alarms_${stamp}.pdf`);
      return tablePdf(res, 'Alarm Report', rows,
        ['Machine', 'Shift', 'Alarm code', 'Alarm name', 'Severity', 'Generated', 'Closed', 'Duration', 'Status'],
        [80, 60, 70, 150, 55, 105, 105, 60, 50]);
    }
    return res.status(400).json({ status: 'error', message: 'format must be xlsx, csv or pdf' });
  } catch (err) {
    console.error('Alarm export error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 4 — Periodic Maintenance
   Time-based maintenance: due because the calendar says so, as opposed
   to Screen 3's work which is due because a machine started alarming.
   ───────────────────────────────────────────────────────────── */

exports.periodic = async (req, res) => {
  try {
    const data = await periodicSvc.getPeriodic({
      company_id: req.user.company_id,
      machine_id: req.query.machine_id,
      search:     req.query.search,
      status:     req.query.status,
      page:       req.query.page,
      limit:      req.query.limit
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Periodic dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.listPeriodicSchedules = async (req, res) => {
  try {
    const data = await periodicSvc.listSchedules({
      company_id: req.user.company_id,
      machine_id: req.query.machine_id
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.savePeriodicSchedule = async (req, res) => {
  try {
    const data = await periodicSvc.upsertSchedule({
      ...req.body,
      company_id: req.user.company_id,
      user_id:    req.user.id
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.deletePeriodicSchedule = async (req, res) => {
  try {
    await periodicSvc.deleteSchedule({ id: req.params.id, company_id: req.user.company_id });
    return res.json({ status: 'success' });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* Raise the occurrences that are due now instead of waiting for the cron. */
exports.runPeriodicEngine = async (req, res) => {
  try {
    const result = await periodicEngine.evaluateCompany(req.user.company_id, { createdBy: req.user.id });
    return res.json({
      status: 'success', data: result,
      message: `${result.created} periodic ticket(s) raised from ${result.advanced} schedule(s)`
    });
  } catch (err) {
    console.error('Periodic engine error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* Export the ticket list. Excel and CSV come from the same rows so the two
   downloads can never disagree; PDF is a printed summary, not a data dump. */
exports.exportPeriodic = async (req, res) => {
  try {
    const format = String(req.params.format || '').toLowerCase();
    const rows = await periodicSvc.getExportRows({
      company_id: req.user.company_id,
      machine_id: req.query.machine_id,
      search:     req.query.search,
      status:     req.query.status
    });

    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Nothing to export for these filters' });
    }

    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = excel.createExcel('Periodic Maintenance', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=periodic_maintenance_${stamp}.xlsx`);
      return res.send(file);
    }

    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=periodic_maintenance_${stamp}.csv`)
        .send(toCsv(rows));
    }

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=periodic_maintenance_${stamp}.pdf`);
      return tablePdf(res, 'Periodic Maintenance', rows,
        ['Ticket', 'Machine', 'Task', 'Frequency', 'Priority', 'Status', 'Due date', 'Completed', 'Overdue', 'Technician'],
        [45, 85, 175, 70, 60, 70, 70, 70, 50, 90]);
    }

    return res.status(400).json({ status: 'error', message: 'format must be xlsx, csv or pdf' });
  } catch (err) {
    console.error('Periodic export error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};



/* Phase 2 · Screen 3 — Preventive Maintenance Dashboard */
exports.preventive = async (req, res) => {
  try {
    const data = await preventiveSvc.getPreventiveDashboard(req);
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Preventive dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* Threshold rules — what turns repeated alarms into PM tickets. */
exports.listThresholds = async (req, res) => {
  try {
    const data = await preventiveSvc.listThresholds(req.user.company_id);
    return res.json({ status: 'success', data });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.saveThreshold = async (req, res) => {
  try {
    const data = await preventiveSvc.upsertThreshold(req.user.company_id, req.body, req.user.id);
    return res.json({ status: 'success', data });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.deleteThreshold = async (req, res) => {
  try {
    await preventiveSvc.deleteThreshold(req.user.company_id, req.params.id);
    return res.json({ status: 'success' });
  } catch (err) {
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* Run the engine now rather than waiting for the next cron tick. */
exports.runPmEngine = async (req, res) => {
  try {
    const result = await pmEngine.evaluateCompany(req.user.company_id, { createdBy: req.user.id });
    return res.json({ status: 'success', data: result,
      message: `${result.created} preventive ticket(s) raised` });
  } catch (err) {
    console.error('PM engine error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

/* Phase 2 · Screen 2 — Maintenance Dashboard */
exports.maintenance = async (req, res) => {
  try {
    const data = await maintenanceSvc.getMaintenanceDashboard(req);
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Maintenance dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};

exports.factory = async (req, res) => {
  try {
    const data = await factorySvc.getFactoryDashboard(req);
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Factory dashboard error:', err);
    return res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
};
