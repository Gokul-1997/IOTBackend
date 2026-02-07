const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');

router.get('/live', auth, ctrl.live);
router.get('/hourly-oee', auth, ctrl.hourlyOee);
router.get('/shift-oee', auth, ctrl.shiftOee);
router.get('/operator-live', auth, ctrl.operatorLive);

module.exports = router;
