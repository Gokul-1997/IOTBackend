const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./pdf.controller');

router.get('/oee',         auth, ctrl.exportOEEPdf);
router.get('/maintenance', auth, ctrl.exportMaintenancePdf);

module.exports = router;
