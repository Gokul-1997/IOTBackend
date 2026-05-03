const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./downtime.controller');

router.get('/reasons',       auth, ctrl.getReasons);
router.post('/reasons',      auth, ctrl.createReason);
router.put('/reasons/:id',   auth, ctrl.updateReason);
router.get('/events',        auth, ctrl.getEvents);
router.post('/events',       auth, ctrl.logEvent);
router.get('/summary',       auth, ctrl.getDowntimeSummary);

module.exports = router;
