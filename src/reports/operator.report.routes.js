const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./operator.report.controller');

router.get('/operator-performance', auth, ctrl.getOperatorPerformance);

module.exports = router;
