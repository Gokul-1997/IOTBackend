const express = require('express');
const router = express.Router();
const ctrl = require('./shift.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');

router.get('/', auth, permit('shift.view'), ctrl.getShifts);
router.post('/', auth, permit('shift.create'), ctrl.createShift);
router.put('/:id', auth, permit('shift.update'), ctrl.updateShift);
router.patch('/:id/status', auth, permit('shift.update'), ctrl.toggleShift);

module.exports = router;
