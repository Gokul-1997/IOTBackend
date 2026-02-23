const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');

// Machine card list
router.get('/', auth, ctrl.dashboard);

// Machine full detail page
router.get('/detail/:machine_id', auth, ctrl.machineDetail);

// Live data (poll every 2 sec)
router.get('/live/:machine_id', auth, ctrl.liveSingle);

// Timeline (last 8 hours)
router.get('/timeline/:machine_id', auth, ctrl.timeline);

// Spindle + Feed trend
router.get('/trend/:machine_id', auth, ctrl.trend);

// Dashboard summary (shift + counts)
router.get('/summary', auth, ctrl.dashboardSummary);

module.exports = router;