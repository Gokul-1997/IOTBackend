const svc   = require('./report.service');
const { assertDirectRange, rangeDays, MAX_DIRECT_DAYS, MAX_DIRECT_ROWS } = require('./report.limits');
const { REPORT_COLUMNS, assertType, resolveColumns, sortRows } = require('./report.columns');
const { emailInstead } = require('./report.mailer');

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
   DOWNLOADS — the report on screen, as Excel or CSV

   ?format=xlsx|csv&date_from=&date_to=&machine_id=&shift_id=&operator_id=
   &columns=a,b&sort=&dir=
   The rows the screen shows, in its columns and order. (The Excel download
   was the first day only, every machine and every column.) ?date= alone —
   the old single-day request — still works.

   A small report is the file. A large one — more than MAX_DIRECT_ROWS rows,
   or a range past three months — is answered 202 "check your email in 10–15
   minutes", then built and emailed, attached, to the person who asked
   (report.mailer.js). There is no Email button.
───────────────────────────────────────────────────────── */

const FORMATS = ['xlsx', 'csv'];

/** An optional id filter: absent, or a positive whole number — never passed on to SQL as anything else. */
function idFilter(query, name) {
  const v = query[name];
  if (v === undefined || v === null || v === '') return null;
  if (!/^[1-9]\d{0,9}$/.test(String(v))) {
    const e = new Error(`${name} must be a positive whole number`);
    e.status = 400; e.code = 'INVALID_FILTER';
    throw e;
  }
  return String(v);
}

/** ?columns=a,b or ?columns=a&columns=b */
const listParam = v => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map(s => String(s).trim()).filter(Boolean);

const download = type => async (req, res, next) => {
  try {
    const q = req.query;
    const format = String(q.format || 'xlsx').toLowerCase();
    if (!FORMATS.includes(format)) {
      return res.status(400).json({ status: 'error', message: 'format must be xlsx or csv' });
    }
    const date_from = q.date_from || q.date;
    const date_to = q.date_to || date_from;
    const days = rangeDays(date_from, date_to);              // 400: missing, malformed or reversed
    const filters = {
      date_from, date_to,
      machine_id: idFilter(q, 'machine_id'), shift_id: idFilter(q, 'shift_id'), operator_id: idFilter(q, 'operator_id')
    };
    // everything checkable is checked before anything is read or answered
    const columns = resolveColumns(type, listParam(q.columns)).map(c => c.key);
    sortRows([], type, q.sort, q.dir);
    const spec = { company_id: req.user.company_id, type, format, filters, columns, sort: q.sort, dir: q.dir };

    const rows = days <= MAX_DIRECT_DAYS ? await svc.reportRows(type, req.user.company_id, filters) : null;
    if (rows && rows.length <= MAX_DIRECT_ROWS) {
      const file = await svc.buildFile({ ...spec, rows });
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      return res.send(file.body);
    }

    return await emailInstead(req, res, {
      name: svc.REPORT_NAMES[type], dateFrom: date_from, dateTo: date_to,
      count: rows ? rows.length : null, reason: rows ? 'rows' : 'range',
      filters,
      build: () => svc.buildFile({ ...spec, rows })            // a long range is read here, after the answer
    });
  } catch (err) { next(err); }
};

exports.hourlyOeeExcel  = download('oee-hourly');
exports.shiftOeeExcel   = download('shift-oee');
exports.productionExcel = download('production');


/* ─────────────────────────────────────────────────────────
   COLUMN DEFINITIONS
───────────────────────────────────────────────────────── */

/* Serves the same definition the files are built from, so the picker cannot
   offer a column the report cannot produce. */
exports.getColumns = async (req, res, next) => {
  try {
    const type = assertType(req.query.type);
    res.json({
      status: 'success',
      data: { type, columns: REPORT_COLUMNS[type], max_direct_days: MAX_DIRECT_DAYS, max_direct_rows: MAX_DIRECT_ROWS }
    });
  } catch (e) { next(e); }
};
