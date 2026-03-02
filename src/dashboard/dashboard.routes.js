const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');

/* =====================================================
   DASHBOARD MAIN (Paginated Machine Cards)
   GET /dashboard?page=1&per_page=6
===================================================== */
router.get('/', auth, ctrl.dashboard);


/* =====================================================
   DASHBOARD SUMMARY (Header Counts)
   GET /dashboard/summary
===================================================== */
router.get('/summary', auth, ctrl.dashboardSummary);


/* =====================================================
   MACHINE DETAIL PAGE
   GET /dashboard/:machine_id/detail
===================================================== */
router.get('/:machine_id/detail', auth, ctrl.machineDetail);


/* =====================================================
   MACHINE TIMELINE (Last 8 Hours)
   GET /dashboard/:machine_id/timeline
===================================================== */
router.get('/:machine_id/timeline', auth, ctrl.timeline);


/* =====================================================
   MACHINE TREND (Spindle + Feed)
   GET /dashboard/:machine_id/trend
===================================================== */
router.get('/:machine_id/trend', auth, ctrl.trend);


module.exports = router;