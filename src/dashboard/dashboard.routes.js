const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');

/* =====================================================
   DASHBOARD MAIN (Paginated Machine Cards)
   GET /dashboard?page=1&per_page=6
===================================================== */
router.get('/', auth, ctrl.dashboard);


/* =====================================================
   MACHINE DETAIL PAGE
   GET /dashboard/:machine_id/detail
===================================================== */
router.get('/live/:machine_id', auth, ctrl.machineDetail);



module.exports = router;