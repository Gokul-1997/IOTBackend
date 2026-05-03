const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./maintenance.controller');

router.get('/schedules',         auth, ctrl.getSchedules);
router.post('/schedules',        auth, ctrl.createSchedule);
router.put('/schedules/:id',     auth, ctrl.updateSchedule);
router.delete('/schedules/:id',  auth, ctrl.deleteSchedule);
router.get('/logs',              auth, ctrl.getLogs);
router.post('/logs',             auth, ctrl.createLog);
router.get('/upcoming',          auth, ctrl.getUpcoming);
router.get('/mttr',              auth, ctrl.getMTTR);

module.exports = router;
