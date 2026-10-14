const router = require('express').Router();
const ctrl = require('./assignment.controller');
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const validate = require('../middleware/validate.middleware');

router.post('/operator-machine', auth, access('page:assignments:create'), validate({
  operator_id: { required: true, label: 'Operator' },
  machine_id:  { required: true, label: 'Machine' }
}), ctrl.operatorMachine);

router.post('/operator-shift', auth, access('page:assignments:create'), validate({
  operator_id: { required: true, label: 'Operator' },
  shift_id:    { required: true, label: 'Shift' }
}), ctrl.operatorShift);

module.exports = router;
