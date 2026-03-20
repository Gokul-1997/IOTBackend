const router = require('express').Router();
const ctrl = require('./role.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');

router.post('/', auth, role(['ADMIN']), validate({
  role_name: { required: true, maxLength: 50, label: 'Role name' }
}), ctrl.create);

router.post('/assign/:id', auth, role(['ADMIN']), validate({
  role_ids: { required: true, type: 'array', minItems: 1, label: 'Role IDs' }
}), ctrl.assign);

module.exports = router;
