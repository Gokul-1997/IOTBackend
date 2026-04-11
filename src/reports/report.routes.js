const router = require('express').Router();
const ctrl   = require('./report.controller');
const auth   = require('../middleware/auth.middleware');
const role   = require('../middleware/role.middleware');

const adminOrSup = [auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN', 'SUPERVISOR'])];

/* ── Dropdowns ── */
router.get('/machines',         ...adminOrSup, ctrl.getMachines);
router.get('/shifts',           ...adminOrSup, ctrl.getShifts);
router.get('/operators',        ...adminOrSup, ctrl.getOperators);

/* ── JSON data (in-page preview) ── */
router.get('/production-data',  ...adminOrSup, ctrl.productionData);
router.get('/oee-hourly-data',  ...adminOrSup, ctrl.oeeHourlyData);
router.get('/shift-oee-data',   ...adminOrSup, ctrl.shiftOeeData);

/* ── Excel downloads ── */
router.get('/hourly-oee',       ...adminOrSup, ctrl.hourlyOeeExcel);
router.get('/shift-oee',        ...adminOrSup, ctrl.shiftOeeExcel);
router.get('/production',       ...adminOrSup, ctrl.productionExcel);

module.exports = router;
