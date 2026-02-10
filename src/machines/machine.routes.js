const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const controller = require('./machine.controller');

// ADMIN – create machine
router.post('/', auth, permit('CREATE_MACHINE'), controller.createMachine);

// ALL USERS – view machines
router.get('/', auth, permit('VIEW_MACHINE'), controller.getMachines);

// ADMIN – enable / disable machine
router.patch('/:id/status', auth, permit('CREATE_MACHINE'), controller.toggleMachineStatus);

// ADMIN – regenerate API key
router.post('/:id/regenerate-key', auth, permit('CREATE_MACHINE'), controller.regenerateApiKey);

module.exports = router;
