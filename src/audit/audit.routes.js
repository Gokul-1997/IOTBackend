const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./audit.controller');

router.get('/', auth, ctrl.getLogs);

module.exports = router;
