const router = require('express').Router();
const ctrl = require('./operator.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');

router.post('/', auth,  permit('operator.create'), ctrl.create);
router.get('/', auth, permit('operator.view'), ctrl.list);

module.exports = router;
