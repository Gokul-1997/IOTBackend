const router = require('express').Router();
const ctrl = require('./operator.controller');
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const validate = require('../middleware/validate.middleware');

router.post('/', auth, access('page:operators:create'), validate({
  operator_code: { required: true, maxLength: 50,  label: 'Operator code' },
  operator_name: { required: true, maxLength: 100, label: 'Operator name' },
  shift_id:      { required: true, label: 'Shift' }
}), ctrl.create);
router.get('/', auth, permit('operator.view'), ctrl.list);
router.put('/:id', auth, access('page:operators:edit'), ctrl.update);
router.get('/:id', auth, permit('operator.view'), ctrl.getById);
router.delete('/:id', auth, access('page:operators:delete'), ctrl.remove);
module.exports = router;
