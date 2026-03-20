const router = require('express').Router();
const ctrl = require('./component.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const validate = require('../middleware/validate.middleware');

// router.post('/', auth, permit('component.create'), ctrl.create);
// router.get('/', auth, permit('component.view'), ctrl.list);
// router.put('/:id', auth, permit('component.update'), ctrl.update);
// router.delete('/:id', auth, permit('component.delete'), ctrl.remove);

router.post('/', auth, validate({
  machine_id:   { required: true, label: 'Machine' },
  part_name:    { required: true, maxLength: 100, label: 'Part name' },
  part_number:  { required: true, maxLength: 50,  label: 'Part number' },
  cycle_time:   { required: true, type: 'number', min: 0, label: 'Cycle time' },
  target:       { required: true, type: 'number', min: 1, label: 'Target' }
}), ctrl.create);
router.get('/', auth, ctrl.list);
router.put('/:id', auth, ctrl.update);
router.delete('/:id', auth, ctrl.remove);

module.exports = router;