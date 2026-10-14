const router = require('express').Router();
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const heavy = require('../middleware/heavy.middleware');
const ctrl = require('./operator.report.controller');

router.get('/operator-performance', auth, access.any('page:reports:view', 'page:analytics-operators:view'), heavy, ctrl.getOperatorPerformance);

module.exports = router;
