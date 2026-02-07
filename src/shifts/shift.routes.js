const express = require('express');
const router = express.Router();
const ctrl = require('./shift.controller');
const auth = require('../middleware/auth.middleware');

router.get('/', auth, ctrl.getShifts);
router.post('/', auth, ctrl.createShift);
router.put('/:id', auth, ctrl.updateShift);
router.patch('/:id/status', auth, ctrl.toggleShift);

module.exports = router;
