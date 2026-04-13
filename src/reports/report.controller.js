const svc   = require('./report.service');
const excel = require('./excel.util');

/* ─────────────────────────────────────────────────────────
   DROPDOWNS
───────────────────────────────────────────────────────── */

exports.getMachines = async (req, res, next) => {
  try { res.json({ status: 'success', data: await svc.getMachines(req.user.company_id) }); }
  catch (err) { next(err); }
};

exports.getShifts = async (req, res, next) => {
  try { res.json({ status: 'success', data: await svc.getShifts(req.user.company_id) }); }
  catch (err) { next(err); }
};

exports.getOperators = async (req, res, next) => {
  try { res.json({ status: 'success', data: await svc.getOperators(req.user.company_id) }); }
  catch (err) { next(err); }
};

/* ─────────────────────────────────────────────────────────
   JSON DATA  (in-page preview)
───────────────────────────────────────────────────────── */

exports.productionData = async (req, res, next) => {
  try {
    const { date_from, date_to, machine_id, shift_id, operator_id } = req.query;
    res.json({
      status: 'success',
      data: await svc.productionData(
        req.user.company_id, date_from, date_to || date_from,
        machine_id || null, shift_id || null, operator_id || null
      )
    });
  } catch (err) { next(err); }
};

exports.oeeHourlyData = async (req, res, next) => {
  try {
    const { date_from, date_to, machine_id, shift_id, operator_id } = req.query;
    res.json({
      status: 'success',
      data: await svc.oeeHourlyData(
        req.user.company_id, date_from, date_to || date_from,
        machine_id || null, shift_id || null, operator_id || null
      )
    });
  } catch (err) { next(err); }
};

exports.shiftOeeData = async (req, res, next) => {
  try {
    const { date_from, date_to, machine_id, shift_id, operator_id } = req.query;
    res.json({
      status: 'success',
      data: await svc.shiftOeeData(
        req.user.company_id, date_from, date_to || date_from,
        machine_id || null, shift_id || null, operator_id || null
      )
    });
  } catch (err) { next(err); }
};

/* ─────────────────────────────────────────────────────────
   EXCEL DOWNLOADS
───────────────────────────────────────────────────────── */

exports.hourlyOeeExcel = async (req, res, next) => {
  try {
    const data = await svc.hourlyOee(req.user.company_id, req.query.date);
    const file = excel.createExcel('Hourly OEE', data);
    res.setHeader('Content-Disposition', `attachment; filename=hourly_oee_${req.query.date}.xlsx`);
    res.send(file);
  } catch (err) { next(err); }
};

exports.shiftOeeExcel = async (req, res, next) => {
  try {
    const data = await svc.shiftOee(req.user.company_id, req.query.date);
    const file = excel.createExcel('Shift OEE', data);
    res.setHeader('Content-Disposition', `attachment; filename=shift_oee_${req.query.date}.xlsx`);
    res.send(file);
  } catch (err) { next(err); }
};

exports.productionExcel = async (req, res, next) => {
  try {
    const data = await svc.production(req.user.company_id, req.query.date);
    const file = excel.createExcel('Production', data);
    res.setHeader('Content-Disposition', `attachment; filename=production_${req.query.date}.xlsx`);
    res.send(file);
  } catch (err) { next(err); }
};
