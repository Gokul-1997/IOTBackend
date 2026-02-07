const router = require('express').Router();
const ctrl = require('./report.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');

router.get('/hourly-oee', auth, role(['ADMIN','SUPERVISOR']), ctrl.hourlyOeeExcel);
router.get('/shift-oee', auth, role(['ADMIN','SUPERVISOR']), ctrl.shiftOeeExcel);
router.get('/production', auth, role(['ADMIN','SUPERVISOR']), ctrl.productionExcel);

module.exports = router;
