const router = require('express').Router();
const ctrl = require('./assignment.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');

router.post('/operator-machine', auth, role(['ADMIN','SUPERVISOR']), ctrl.operatorMachine);
router.post('/operator-shift', auth, role(['ADMIN','SUPERVISOR']), ctrl.operatorShift);

module.exports = router;
