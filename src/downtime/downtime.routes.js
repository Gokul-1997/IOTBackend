const router = require('express').Router();
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const ctrl = require('./downtime.controller');
const scoped = require('../middleware/plant-scope.middleware')();

router.get('/reasons',       auth, access('page:downtime:view'), scoped, ctrl.getReasons);
router.post('/reasons',      auth, access('page:downtime:create'), scoped, ctrl.createReason);
router.put('/reasons/:id',   auth, access('page:downtime:edit'), scoped, ctrl.updateReason);
router.get('/events',        auth, access('page:downtime:view'), scoped, ctrl.getEvents);
router.post('/events',       auth, access('page:downtime:create'), scoped, ctrl.logEvent);
router.get('/summary',       auth, access('page:downtime:view'), scoped, ctrl.getDowntimeSummary);

module.exports = router;
