const router = require('express').Router();
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const ctrl = require('./downtime.controller');
const scoped = require('../middleware/plant-scope.middleware')();
const canDeleteReason = access('page:downtime:delete');
// Older API clients may deactivate through PUT. It is the same removal
// action, so it needs Delete as well as Edit rather than bypassing its grant.
const deletionAccess = (req, res, next) => req.body?.is_active === false ? canDeleteReason(req, res, next) : next();

router.get('/reasons',       auth, access('page:downtime:view'), scoped, ctrl.getReasons);
router.post('/reasons',      auth, access('page:downtime:create'), scoped, ctrl.createReason);
router.put('/reasons/:id',   auth, access('page:downtime:edit'), deletionAccess, scoped, ctrl.updateReason);
router.delete('/reasons/:id', auth, canDeleteReason, scoped, ctrl.deleteReason);
router.get('/events',        auth, access('page:downtime:view'), scoped, ctrl.getEvents);
router.post('/events',       auth, access('page:downtime:create'), scoped, ctrl.logEvent);
router.get('/summary',       auth, access('page:downtime:view'), scoped, ctrl.getDowntimeSummary);

module.exports = router;
