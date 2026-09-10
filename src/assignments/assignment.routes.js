const router = require('express').Router();
const ctrl = require('./assignment.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');

router.post('/operator-machine', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN', 'SUPERVISOR']), validate({
  operator_id: { required: true, label: 'Operator' },
  machine_id:  { required: true, label: 'Machine' }
}), ctrl.operatorMachine);

router.post('/operator-shift', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN', 'SUPERVISOR']), validate({
  operator_id: { required: true, label: 'Operator' },
  shift_id:    { required: true, label: 'Shift' }
}), ctrl.operatorShift);

module.exports = router;
