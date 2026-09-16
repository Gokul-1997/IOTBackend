const svc   = require('./report.service');
const { assertDirectRange, rangeDays, MAX_DIRECT_DAYS } = require('./report.limits');
const { REPORT_COLUMNS, assertType } = require('./report.columns');
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
  try {
    const machine_id = req.query.machine_id || null;
    res.json({ status: 'success', data: await svc.getOperators(req.user.company_id, machine_id) });
  }
  catch (err) { next(err); }
};

/* ─────────────────────────────────────────────────────────
   JSON DATA  (in-page preview)
───────────────────────────────────────────────────────── */

exports.productionData = async (req, res, next) => {
  try {
    const { date_from, date_to, machine_id, shift_id, operator_id } = req.query;
    /* Refused rather than served slowly: beyond three months the answer is
       an emailed spreadsheet, not a larger JSON body. */
    assertDirectRange(date_from, date_to);
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
    /* Refused rather than served slowly: beyond three months the answer is
       an emailed spreadsheet, not a larger JSON body. */
    assertDirectRange(date_from, date_to);
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
    /* Refused rather than served slowly: beyond three months the answer is
       an emailed spreadsheet, not a larger JSON body. */
    assertDirectRange(date_from, date_to);
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


/* ─────────────────────────────────────────────────────────
   COLUMN DEFINITIONS + EMAILED REPORTS
───────────────────────────────────────────────────────── */

/* Serves the same definition the emailed spreadsheet is built from, so the
   picker cannot offer a column the report cannot produce. */
exports.getColumns = async (req, res, next) => {
  try {
    const type = assertType(req.query.type);
    res.json({
      status: 'success',
      data: { type, columns: REPORT_COLUMNS[type], max_direct_days: MAX_DIRECT_DAYS }
    });
  } catch (e) { next(e); }
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email a report whose range is too long to download.
 *
 * Answers 202 as soon as the request is understood, then builds and sends —
 * rendering a year of hourly rows into a spreadsheet takes longer than a
 * request should stay open. This deployment has no job queue, so a failure
 * after the 202 can only be logged; everything checkable (type, columns,
 * dates, recipient) is therefore checked *before* answering.
 */
exports.emailReport = async (req, res, next) => {
  try {
    const { type, date_from, date_to, machine_id, shift_id, operator_id,
            columns, email, labels } = req.body || {};

    assertType(type);
    rangeDays(date_from, date_to);        // rejects malformed or reversed dates

    const to = String(email || await svc.getUserEmail(req.user.id) || '').trim();
    if (!EMAIL_RE.test(to)) {
      return res.status(400).json({
        status: 'error',
        code: 'NO_RECIPIENT',
        message: 'There is no email address on your account. Enter one to have the report sent.'
      });
    }

    const filters = { date_from, date_to, machine_id, shift_id, operator_id };
    const requestedBy = req.user.username || `user ${req.user.id}`;

    res.status(202).json({
      status: 'success',
      data: { queued: true, to, message: `The report is being prepared and will be emailed to ${to}.` }
    });

    svc.emailReport({
      company_id: req.user.company_id,
      type, filters, columns, to, requestedBy,
      labelFor: labels || {}
    })
      .then(sent => console.log('[reports] emailed', JSON.stringify(sent)))
      .catch(err => console.error('[reports] email failed', {
        type, to, company_id: req.user.company_id, error: err.message
      }));
  } catch (e) { next(e); }
};
