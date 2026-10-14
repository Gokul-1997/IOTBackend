const router = require('express').Router();
const ctrl   = require('./report.controller');
const auth   = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
/* report data and files: a few at a time per company (see the middleware) */
const heavy  = require('../middleware/heavy.middleware');

const viewers = [auth, access('page:reports:view')];
const exporters = [auth, access('page:reports:export')];

/* ── Dropdowns ── */
router.get('/machines',         ...viewers, ctrl.getMachines);
router.get('/shifts',           ...viewers, ctrl.getShifts);
router.get('/operators',        ...viewers, ctrl.getOperators);

/* ── JSON data (in-page preview) ── */
router.get('/production-data',  ...viewers, heavy, ctrl.productionData);
router.get('/oee-hourly-data',  ...viewers, heavy, ctrl.oeeHourlyData);
router.get('/shift-oee-data',   ...viewers, heavy, ctrl.shiftOeeData);

/* ── Column definitions + emailed reports ── */
router.get('/columns',          ...viewers, ctrl.getColumns);
router.post('/email',           ...exporters, heavy, ctrl.emailReport);

/* ── Excel downloads ── */
router.get('/hourly-oee',       ...exporters, heavy, ctrl.hourlyOeeExcel);
router.get('/shift-oee',        ...exporters, heavy, ctrl.shiftOeeExcel);
router.get('/production',       ...exporters, heavy, ctrl.productionExcel);

module.exports = router;
