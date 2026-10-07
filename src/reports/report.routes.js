const router = require('express').Router();
const ctrl   = require('./report.controller');
const auth   = require('../middleware/auth.middleware');
const role   = require('../middleware/role.middleware');
/* report data and files: a few at a time per company (see the middleware) */
const heavy  = require('../middleware/heavy.middleware');

const adminOrSup = [auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN', 'SUPERVISOR'])];

/* ── Dropdowns ── */
router.get('/machines',         ...adminOrSup, ctrl.getMachines);
router.get('/shifts',           ...adminOrSup, ctrl.getShifts);
router.get('/operators',        ...adminOrSup, ctrl.getOperators);

/* ── JSON data (in-page preview) ── */
router.get('/production-data',  ...adminOrSup, heavy, ctrl.productionData);
router.get('/oee-hourly-data',  ...adminOrSup, heavy, ctrl.oeeHourlyData);
router.get('/shift-oee-data',   ...adminOrSup, heavy, ctrl.shiftOeeData);

/* ── Column definitions + emailed reports ── */
router.get('/columns',          ...adminOrSup, ctrl.getColumns);
router.post('/email',           ...adminOrSup, heavy, ctrl.emailReport);

/* ── Excel downloads ── */
router.get('/hourly-oee',       ...adminOrSup, heavy, ctrl.hourlyOeeExcel);
router.get('/shift-oee',        ...adminOrSup, heavy, ctrl.shiftOeeExcel);
router.get('/production',       ...adminOrSup, heavy, ctrl.productionExcel);

module.exports = router;
