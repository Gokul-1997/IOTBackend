const router = require('express').Router();
const ctrl = require('./operator.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');

router.post('/', auth, role(['ADMIN','SUPERVISOR']), ctrl.create);
router.get('/', auth, ctrl.list);

module.exports = router;
