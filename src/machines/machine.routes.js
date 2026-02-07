const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const controller = require('./machine.controller');


router.post('/', auth, permit('CREATE_MACHINE'), controller.createMachine);

router.get('/', auth, permit('CREATE_MACHINE'), controller.getMachines);

router.patch('/:id/status', auth, permit('CREATE_MACHINE'), controller.toggleMachineStatus);

router.post('/:id/regenerate-key', auth, permit('CREATE_MACHINE'), controller.regenerateApiKey);

router.post('/auth', controller.machineAuth);

module.exports = router;
