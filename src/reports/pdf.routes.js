const router = require('express').Router();
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const heavy = require('../middleware/heavy.middleware');
const ctrl = require('./pdf.controller');

router.get('/oee',         auth, access.any('page:reports:export', 'page:oee-reports:export'), heavy, ctrl.exportOEEPdf);
router.get('/maintenance', auth, access('page:maintenance-report:export'), heavy, ctrl.exportMaintenancePdf);

module.exports = router;
