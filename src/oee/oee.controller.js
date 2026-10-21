const { effectivePlantId } = require('../lib/plant-scope');
/**
 * OEE REPORTS CONTROLLER — the Reports page's OEE Records tab.
 *
 * Errors go to the error middleware: a refused filter (400), range (413) or
 * permission keeps its message; anything unexpected is logged under a
 * reference instead of being shown.
 */

const OeeService = require('./oee.service');
const { MAX_DIRECT_DAYS, MAX_DIRECT_ROWS } = require('../reports/report.limits');
const { emailInstead } = require('../reports/report.mailer');

/* ===============================================
   GET META (Machines, Shifts, Lines)
   GET /oee/meta
   =============================================== */
exports.getMeta = async (req, res, next) => {
  try {
    const data = await OeeService.getMeta(effectivePlantId(req.user), req.user.company_id);
    return res.json({ status: 'success', data });
  } catch (err) { next(err); }
};

/* ===============================================
   GET REPORTS — a page of records
   GET /oee/reports?from_date=&to_date=&machine_id=&shift_id=&page=1
   =============================================== */
exports.getReports = async (req, res, next) => {
  try {
    const result = await OeeService.getReports(req.query, effectivePlantId(req.user), req.user.company_id);
    return res.json({ status: 'success', ...result });
  } catch (err) { next(err); }
};

/* ===============================================
   EXPORT — every record for the filters, as CSV or Excel
   GET /oee/export?format=csv|xlsx&from_date=&to_date=&…&columns=&sort_by=&sort_order=
   The table's columns under its headings, in its order. No format: CSV, as
   before Excel was offered. A large export — more than MAX_DIRECT_ROWS
   records, or a range past three months — is not downloaded: it is answered
   202 "check your email in 10–15 minutes", then built and emailed (report.mailer).
   =============================================== */
const FORMATS = ['csv', 'xlsx'];

exports.exportRecords = async (req, res, next) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!FORMATS.includes(format)) {
      return res.status(400).json({ status: 'error', message: 'format must be xlsx or csv' });
    }

    const companyId = req.user.company_id;
    const plan = OeeService.exportPlan(req.query, effectivePlantId(req.user), companyId);
    const rows = plan.days <= MAX_DIRECT_DAYS ? await OeeService.planRows(plan, MAX_DIRECT_ROWS + 1) : null;

    if (rows && rows.length <= MAX_DIRECT_ROWS) {
      if (!rows.length) {
        return res.status(404).json({ status: 'error', message: 'No OEE records match these filters' });
      }
      const file = await OeeService.buildFile(plan, format, rows);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      return res.send(file.body);
    }

    const count = await OeeService.planCount(plan);
    if (!count) {
      return res.status(404).json({ status: 'error', message: 'No OEE records match these filters' });
    }
    return await emailInstead(req, res, {
      name: 'OEE Records', dateFrom: plan.from, dateTo: plan.to, count,
      reason: rows ? 'rows' : 'range', link: '/reports?tab=oee-records',
      filters: plan.filters,
      build: () => OeeService.buildFile(plan, format)          // read after the answer
    });
  } catch (err) { next(err); }
};
