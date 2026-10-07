const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const heavy = require('../middleware/heavy.middleware');
const ctrl = require('./operator.report.controller');

router.get('/operator-performance', auth, heavy, ctrl.getOperatorPerformance);

module.exports = router;
