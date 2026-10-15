const router = require('express').Router();
const ctrl = require('./component.controller');
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');


router.post('/', auth, access('page:component:create'), validate({
  machine_id:   { required: true, label: 'Machine' },
  part_name:    { required: true, maxLength: 100, label: 'Part name' },
  part_number:  { required: true, maxLength: 50,  label: 'Part number' },
  cycle_time:   { required: true, type: 'string', time_hms: true, label: 'Cycle time' },
  target:       { required: true, type: 'number', min: 1, label: 'Target' }
}), ctrl.create);
router.get('/', auth, access.any('page:component:view', 'page:job:view'), ctrl.list);
router.put('/:id', auth, access('page:component:edit'), ctrl.update);
router.delete('/:id', auth, access('page:component:delete'), ctrl.remove);

module.exports = router;
