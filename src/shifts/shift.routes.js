const express = require('express');
const router = express.Router();
const ctrl = require('./shift.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const validate = require('../middleware/validate.middleware');

router.get('/', auth, permit('shift.view'), ctrl.getShifts);
router.post('/', auth, permit('shift.create'), validate({
  shift_code:    { required: true, maxLength: 20, label: 'Shift code' },
  start_time:    { required: true, time: true,    label: 'Start time' },
  end_time:      { required: true, time: true,    label: 'End time' },
  break_minutes: { type: 'number', min: 0,        label: 'Break minutes' }
}), ctrl.createShift);
router.put('/:id', auth, permit('shift.update'), ctrl.updateShift);
router.patch('/:id/status', auth, permit('shift.update'), ctrl.toggleShift);

module.exports = router;
