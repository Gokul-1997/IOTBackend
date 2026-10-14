const router = require('express').Router();
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const ctrl = require('./maintenance.controller');
const scoped = require('../middleware/plant-scope.middleware')();
const scopedSchedule = require('../middleware/plant-scope.middleware')({ resource: 'schedule' });

router.get('/schedules',         auth, access('page:maintenance:view'), scoped, ctrl.getSchedules);
router.post('/schedules',        auth, access('page:maintenance:create'), scoped, ctrl.createSchedule);
router.put('/schedules/:id',     auth, access('page:maintenance:edit'), scopedSchedule, ctrl.updateSchedule);
router.delete('/schedules/:id',  auth, access('page:maintenance:delete'), scopedSchedule, ctrl.deleteSchedule);
router.get('/logs',              auth, access('page:maintenance:view'), scoped, ctrl.getLogs);
router.post('/logs',             auth, access('page:maintenance:create'), scoped, ctrl.createLog);
router.get('/upcoming',          auth, access('page:maintenance:view'), scoped, ctrl.getUpcoming);
router.get('/mttr',              auth, access('page:maintenance:view'), scoped, ctrl.getMTTR);

module.exports = router;
