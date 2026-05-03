const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./alarm.controller');

router.get('/', auth, ctrl.getAlarms);
router.patch('/:id/resolve', auth, ctrl.resolveAlarm);
router.get('/preferences', auth, ctrl.getPreferences);
router.put('/preferences', auth, ctrl.updatePreferences);

module.exports = router;
