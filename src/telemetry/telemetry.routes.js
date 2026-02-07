const router = require('express').Router();
const ctrl = require('./telemetry.controller');
const machineAuth = require('../middleware/machine.middleware');

router.post('/', machineAuth, ctrl.push);

module.exports = router;
