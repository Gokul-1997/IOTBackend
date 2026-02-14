const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const controller = require('./machine.controller');

// ADMIN – create machine
router.post('/', auth, permit('machine.create'), controller.createMachine);

// ALL USERS – view machines
router.get('/', auth, permit('machine.view'), controller.getMachines);

// ADMIN – enable / disable machine
router.patch('/:id/status', auth, permit('machine.update'), controller.toggleMachineStatus);

// ADMIN – regenerate API key
router.post('/:id/regenerate-key', auth, permit('machine.update'), controller.regenerateApiKey);

// ADMIN – delete machine
router.delete('/:id', auth, permit('machine.delete'), controller.deleteMachine);


module.exports = router;
