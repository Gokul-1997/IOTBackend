const router = require('express').Router();
const ctrl = require('./ai.controller');
const auth = require('../middleware/auth.middleware');

router.get('/machine-risk', auth, ctrl.machineRisk);

module.exports = router;
