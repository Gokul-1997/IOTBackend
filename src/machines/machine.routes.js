const express = require('express');
const router = express.Router();

const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const validate = require('../middleware/validate.middleware');
const audited = require('../middleware/audit.middleware');
const controller = require('./machine.controller');

// ADMIN – create machine (audited: its program path is where the gateway writes programs)
router.post('/', auth, audited('machine'), access('page:machines:create'), validate({
  machine_serial_no: { required: true, maxLength: 100, label: 'Machine serial number' }
}), controller.createMachine);

// ALL USERS – view machines
router.get('/', auth, permit('machine.view'), controller.getMachines);

router.put('/:id', auth, audited('machine'), access('page:machines:edit'), controller.updateMachine);

// ADMIN – enable / disable machine
router.patch('/:id/status', auth, access('page:machines:edit'), controller.toggleMachineStatus);

// ADMIN – regenerate API key
router.post('/:id/regenerate-key', auth, access('page:machines:edit'), controller.regenerateApiKey);

// ADMIN – delete machine
router.delete('/:id', auth, access('page:machines:delete'), controller.deleteMachine);

// ADMIN – edit machine


module.exports = router;
