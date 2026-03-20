const router = require('express').Router();
const ctrl = require('./user.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');

router.post('/', auth, role(['ADMIN']), validate({
  username: { required: true, minLength: 3, maxLength: 50, label: 'Username' },
  password: { required: true, minLength: 8, label: 'Password' }
}), ctrl.create);
router.get('/', auth, ctrl.list);

module.exports = router;
