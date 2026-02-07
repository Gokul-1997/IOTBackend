const router = require('express').Router();
const ctrl = require('./role.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');

router.post('/', auth, role(['ADMIN']), ctrl.create);
router.post('/assign/:id', auth, role(['ADMIN']), ctrl.assign);

module.exports = router;
