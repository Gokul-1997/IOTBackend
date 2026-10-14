const express = require('express');
const router = express.Router();
const ctrl = require('./shift.controller');
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const validate = require('../middleware/validate.middleware');

router.get('/', auth, permit('shift.view'), ctrl.getShifts);
router.post('/', auth, access('page:shifts:create'), validate({
  shift_code:    { required: true, maxLength: 20, label: 'Shift code' },
  start_time:    { required: true, time: true,    label: 'Start time' },
  end_time:      { required: true, time: true,    label: 'End time' },
  break_minutes: { type: 'number', min: 0,        label: 'Break minutes' }
}), ctrl.createShift);
router.put('/:id', auth, access('page:shifts:edit'), ctrl.updateShift);
router.patch('/:id/status', auth, access('page:shifts:edit'), ctrl.toggleShift);
router.delete('/:id', auth, access('page:shifts:delete'), ctrl.deleteShift);
// when the breaks happen, for the machine page's shift timeline
router.get('/:id/breaks', auth, permit('shift.view'), ctrl.getBreaks);
router.put('/:id/breaks', auth, access('page:shifts:edit'), ctrl.saveBreaks);

module.exports = router;
