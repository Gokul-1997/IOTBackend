const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const heavy = require('../middleware/heavy.middleware');
const ctrl = require('./pdf.controller');

router.get('/oee',         auth, heavy, ctrl.exportOEEPdf);
router.get('/maintenance', auth, heavy, ctrl.exportMaintenancePdf);

module.exports = router;
