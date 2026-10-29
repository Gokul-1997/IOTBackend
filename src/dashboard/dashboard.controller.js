const sendError = require('../utils/controller-error');
const { effectivePlantId } = require('../lib/plant-scope');
const svc = require('./dashboard.service');
const { parseFleetPage, fleetMachines } = require('./fleet-page');
const timelineSvc = require('./timeline.service');
const spindleSvc = require('./spindle.service');
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
const meterSvc      = require('./energy-meter.service');
const maintReportSvc = require('./maintenance-report.service');
const periodicEngine = require('../maintenance/periodic-engine.service');
const excel         = require('../reports/excel.util');
const { toCsv } = require('../utils/export.util');
const dashCache     = require('./cache');

/* Exports are Excel or CSV — the PDF exports were taken out (2026-10-14):
   nobody used them, and a table is read in a spreadsheet. The format is
   checked before anything is read, so a refused one costs no query. */
const EXPORT_FORMATS = ['xlsx', 'csv'];
function exportFormat(req, res) {
  const format = String(req.params.format || '').toLowerCase();
  if (EXPORT_FORMATS.includes(format)) return format;
  res.status(400).json({ status: 'error', message: 'format must be xlsx or csv' });
  return null;
}
const { current: readAuthorization } = require('../lib/read-scope');

/**
 * A dashboard's answer, shared by everyone in the company who asks for the
 * same filters at about the same time (see cache.js): worked out once, not
 * once per person. `live`: the answer is about now whatever the dates (a
 * backlog, what is overdue), so it is never kept as history.
 */
async function sendShared(res, name, req, compute, { live = false } = {}) {
  const ttl = live ? dashCache.LIVE_TTL : dashCache.ttlFor(req.query);
  const body = await dashCache.json(name, req.user.company_id, req.query, ttl,
    async () => ({ status: 'success', data: await compute() }));
  return res.type('application/json').send(body);
}

/* =====================================================
   DASHBOARD (Paginated Machine Cards)
   GET /dashboard?page=1&per_page=6
===================================================== */
exports.dashboard = async (req, res) => {
  try {

    const data = await svc.dashboard(effectivePlantId(req.user), req.user.company_id, parseFleetPage(req.query));

    return res.json({
      status: "success",
      ...data
    });

  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ status: 'error', message: err.message });
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
/* The current shift as Running / Idle / Alarm / Off periods, with its
   breaks — the machine page's shift timeline. */
exports.machineTimeline = async (req, res) => {
  try {
    const data = await timelineSvc.machineTimeline(req.params.machine_id, req.user.company_id);
    if (!data) return res.status(404).json({ status: 'error', message: 'Machine not found' });
    return res.json({ status: 'success', data });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ status: 'error', message: err.message });
    console.error('Machine timeline error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to load the shift timeline' });
  }
};

/* Spindle load, speed and feed: the latest reading and a trend over
   ?range=15m|1h|4h|12h|24h — the machine page's spindle panel. */
exports.machineSpindle = async (req, res) => {
  try {
    const data = await spindleSvc.machineSpindle(req.params.machine_id, req.user.company_id, req.query.range || '1h');
    if (!data) return res.status(404).json({ status: 'error', message: 'Machine not found' });
    return res.json({ status: 'success', data });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ status: 'error', message: err.message });
    console.error('Machine spindle error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to load the spindle readings' });
  }
};

/* The energy meter's own readings: on the Energy screen (any machine of the
   company that has a meter) and on the machine page (that machine). */
async function sendMeter(res, args) {
  try {
    const data = await dashCache.remember('energy:meter', args.companyId,
      { machineId: args.machineId, range: args.range }, dashCache.LIVE_TTL,
      () => meterSvc.meterReadings(args));
    if (!data) return res.status(404).json({ status: 'error', message: 'Machine not found' });
    return res.json({ status: 'success', data });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ status: 'error', message: err.message });
    console.error('Energy meter error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to load the energy meter readings' });
  }
}

exports.energyMeter = (req, res) => sendMeter(res, {
  companyId: req.user.company_id, machineId: req.query.machine_id, range: req.query.range || '24h'
});

exports.machineMeter = (req, res) => sendMeter(res, {
  companyId: req.user.company_id, machineId: req.params.machine_id, range: req.query.range || '24h'
});

/* The machine page's switcher: every machine by name, with its status now.
   GET /dashboard/live */
exports.liveMachines = async (req, res) => {
  try {
    const data = await fleetMachines(req.user.company_id, effectivePlantId(req.user));
    return res.json({ status: 'success', data });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ status: 'error', message: err.message });
    console.error('Live machines error:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to load the machines' });
  }
};

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
      effectivePlantId(req.user),
      machineId,
      req.user.company_id
    );
    if (!data) return res.status(404).json({ status: 'error', message: 'Machine not found' });

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
    return await sendShared(res, 'energy', req, () => energySvc.getEnergy({ ...req.query, company_id: req.user.company_id }));
  } catch (err) {
    console.error('Energy dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.getEnergySettings = async (req, res) => {
  try {
    const data = await energySvc.getSettings(req.user.company_id);
    return res.json({ status: 'success', data });
  } catch (err) {
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.saveEnergySettings = async (req, res) => {
  try {
    const data = await energySvc.saveSettings({
      ...req.body, company_id: req.user.company_id, user_id: req.user.id
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.exportEnergy = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await energySvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No machines match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'xlsx') {
      const file = await excel.createExcel('Energy', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=energy_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=energy_${stamp}.csv`)
        .send(toCsv(rows));
    }
  } catch (err) {
    console.error('Energy export error:', err);
    return sendError(err, req, res, { status: 'error' });
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
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.exportOee = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await oeeDashSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No machines match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = await excel.createExcel('OEE', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=oee_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=oee_${stamp}.csv`)
        .send(toCsv(rows));
    }
  } catch (err) {
    console.error('OEE export error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 7 — Operator Performance
   ───────────────────────────────────────────────────────────── */

exports.operators = async (req, res) => {
  try {
    return await sendShared(res, 'operators', req, () => operatorSvc.getOperators({ ...req.query, company_id: req.user.company_id }));
  } catch (err) {
    console.error('Operator dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.exportOperators = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await operatorSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No operators match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = await excel.createExcel('Operator Performance', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=operator_performance_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=operator_performance_${stamp}.csv`)
        .send(toCsv(rows));
    }
  } catch (err) {
    console.error('Operator export error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 6 — Downtime Reason Loss Analysis
   ───────────────────────────────────────────────────────────── */

exports.downtime = async (req, res) => {
  try {
    return await sendShared(res, 'downtime', req, () => downtimeSvc.getDowntime({ ...req.query, company_id: req.user.company_id }));
  } catch (err) {
    console.error('Downtime dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.exportDowntime = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await downtimeSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No downtime records match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = await excel.createExcel('Downtime', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=downtime_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=downtime_${stamp}.csv`)
        .send(toCsv(rows));
    }
  } catch (err) {
    console.error('Downtime export error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 5 — Alarm Dashboard & Reports
   ───────────────────────────────────────────────────────────── */

exports.alarms = async (req, res) => {
  try {
    return await sendShared(res, 'alarms', req, () => alarmSvc.getAlarms({ ...req.query, company_id: req.user.company_id }));
  } catch (err) {
    console.error('Alarm dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.exportAlarms = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await alarmSvc.getExportRows({ ...req.query, company_id: req.user.company_id });

    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No alarms match these filters' });
    }

    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = await excel.createExcel('Alarms', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=alarms_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=alarms_${stamp}.csv`)
        .send(toCsv(rows));
    }
  } catch (err) {
    console.error('Alarm export error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* ─────────────────────────────────────────────────────────────
   Phase 2 · Screen 4 — Periodic Maintenance
   Time-based maintenance: due because the calendar says so, as opposed
   to Screen 3's work which is due because a machine started alarming.
   ───────────────────────────────────────────────────────────── */

exports.periodic = async (req, res) => {
  try {
    return await sendShared(res, 'periodic', req, () => periodicSvc.getPeriodic({
      company_id: req.user.company_id,
      machine_id: req.query.machine_id,
      search:     req.query.search,
      status:     req.query.status,
      due:        req.query.due,
      page:       req.query.page,
      limit:      req.query.limit,
      part:       req.query.part,
      head:       req.query          // the table's sort and filters (lib/table-query.js)
    }), { live: true });
  } catch (err) {
    console.error('Periodic dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
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
    return sendError(err, req, res, { status: 'error' });
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
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.deletePeriodicSchedule = async (req, res) => {
  try {
    await periodicSvc.deleteSchedule({ id: req.params.id, company_id: req.user.company_id });
    return res.json({ status: 'success' });
  } catch (err) {
    return sendError(err, req, res, { status: 'error' });
  }
};

/* Raise the occurrences that are due now instead of waiting for the cron. */
exports.runPeriodicEngine = async (req, res) => {
  try {
    if (readAuthorization()?.plantId != null) throw Object.assign(new Error('Company-wide maintenance evaluation requires company administration'), { status: 403 });
    const result = await periodicEngine.evaluateCompany(req.user.company_id, { createdBy: req.user.id });
    return res.json({
      status: 'success', data: result,
      message: `${result.created} periodic ticket(s) raised from ${result.advanced} schedule(s)`
    });
  } catch (err) {
    console.error('Periodic engine error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* Export the ticket list. Excel and CSV come from the same rows so the two
   downloads can never disagree. */
exports.exportPeriodic = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await periodicSvc.getExportRows({
      company_id: req.user.company_id,
      machine_id: req.query.machine_id,
      search:     req.query.search,
      status:     req.query.status,
      // the export must honour the same filter the screen is showing
      due:        req.query.due,
      head:       req.query
    });

    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'Nothing to export for these filters' });
    }

    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = await excel.createExcel('Periodic Maintenance', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=periodic_maintenance_${stamp}.xlsx`);
      return res.send(file);
    }

    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=periodic_maintenance_${stamp}.csv`)
        .send(toCsv(rows));
    }


  } catch (err) {
    console.error('Periodic export error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};



/* Phase 2 · Screen 3 — Preventive Maintenance Dashboard */
exports.preventive = async (req, res) => {
  try {
    return await sendShared(res, 'preventive', req, () => preventiveSvc.getPreventiveDashboard(req), { live: true });
  } catch (err) {
    console.error('Preventive dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* Threshold rules — what turns repeated alarms into PM tickets. */
exports.listThresholds = async (req, res) => {
  try {
    const data = await preventiveSvc.listThresholds(req.user.company_id);
    return res.json({ status: 'success', data });
  } catch (err) {
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.saveThreshold = async (req, res) => {
  try {
    const data = await preventiveSvc.upsertThreshold(req.user.company_id, req.body, req.user.id);
    return res.json({ status: 'success', data });
  } catch (err) {
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.deleteThreshold = async (req, res) => {
  try {
    await preventiveSvc.deleteThreshold(req.user.company_id, req.params.id);
    return res.json({ status: 'success' });
  } catch (err) {
    return sendError(err, req, res, { status: 'error' });
  }
};

/* Run the engine now rather than waiting for the next cron tick. */
exports.runPmEngine = async (req, res) => {
  try {
    if (readAuthorization()?.plantId != null) throw Object.assign(new Error('Company-wide maintenance evaluation requires company administration'), { status: 403 });
    const result = await pmEngine.evaluateCompany(req.user.company_id, { createdBy: req.user.id });
    return res.json({ status: 'success', data: result,
      message: `${result.created} preventive ticket(s) raised` });
  } catch (err) {
    console.error('PM engine error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* Phase 2 · Screen 2 — Maintenance Dashboard */
exports.maintenance = async (req, res) => {
  try {
    const data = await maintenanceSvc.getMaintenanceDashboard(req);
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Maintenance dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.factory = async (req, res) => {
  try {
    const data = await factorySvc.getFactoryDashboard(req);
    return res.json({ status: 'success', data });
  } catch (err) {
    console.error('Factory dashboard error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

/* ─────────────────────────────────────────────────────────────
   Maintenance Report — the contract's exportable maintenance record
   ───────────────────────────────────────────────────────────── */

exports.maintenanceReport = async (req, res) => {
  try {
    return await sendShared(res, 'maintenance-report', req, () => maintReportSvc.getReport({ ...req.query, company_id: req.user.company_id }));
  } catch (err) {
    console.error('Maintenance report error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};

exports.exportMaintenanceReport = async (req, res) => {
  try {
    const format = exportFormat(req, res);
    if (!format) return;
    const rows = await maintReportSvc.getExportRows({ ...req.query, company_id: req.user.company_id });
    if (!rows.length) {
      return res.status(404).json({ status: 'error', message: 'No maintenance tickets match these filters' });
    }
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'xlsx') {
      const file = await excel.createExcel('Maintenance', rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=maintenance_${stamp}.xlsx`);
      return res.send(file);
    }
    if (format === 'csv') {
      return res.type('text/csv')
        .setHeader('Content-Disposition', `attachment; filename=maintenance_${stamp}.csv`)
        .send(toCsv(rows));
    }
  } catch (err) {
    console.error('Maintenance report export error:', err);
    return sendError(err, req, res, { status: 'error' });
  }
};
