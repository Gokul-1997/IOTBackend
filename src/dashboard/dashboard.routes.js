const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');

// Paginated dashboard (Plant only)
router.get('/', auth, ctrl.dashboard);

// Machine full detail
router.get('/detail/:machine_id', auth, ctrl.machineDetail);

// Live machine (Redis)
router.get('/live/:machine_id', auth, ctrl.liveSingle);

module.exports = router;
