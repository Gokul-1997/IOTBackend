const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');


router.get('/', auth, ctrl.dashboard);


router.get('/factory', auth, ctrl.factory);

router.get('/maintenance', auth, ctrl.maintenance);

/* Phase 2 · Screen 3 — Preventive Maintenance */
router.get('/preventive', auth, ctrl.preventive);

/* Threshold rules: reading is part of the dashboard, but changing what
   raises tickets is an edit and is gated accordingly. */
router.get('/preventive/thresholds',        auth, ctrl.listThresholds);
router.post('/preventive/thresholds',       auth, permit('page:maintenance:edit'), ctrl.saveThreshold);
router.delete('/preventive/thresholds/:id', auth, permit('page:maintenance:delete'), ctrl.deleteThreshold);
router.post('/preventive/run',              auth, permit('page:maintenance:edit'), ctrl.runPmEngine);

/* Phase 2 · Screen 4 — Periodic Maintenance.
   Literal segments before /:format so "schedules" is never read as one. */
router.get('/periodic', auth, ctrl.periodic);

router.get('/periodic/schedules',        auth, ctrl.listPeriodicSchedules);
router.post('/periodic/schedules',       auth, permit('page:maintenance:edit'),   ctrl.savePeriodicSchedule);
router.delete('/periodic/schedules/:id', auth, permit('page:maintenance:delete'), ctrl.deletePeriodicSchedule);
router.post('/periodic/run',             auth, permit('page:maintenance:edit'),   ctrl.runPeriodicEngine);

router.get('/periodic/export/:format', auth, ctrl.exportPeriodic);

/* Phase 2 · Screen 5 — Alarm Dashboard & Reports. */
router.get('/alarms', auth, ctrl.alarms);
router.get('/alarms/export/:format', auth, ctrl.exportAlarms);

/* Phase 2 · Screen 6 — Downtime Reason Loss Analysis. */
router.get('/downtime', auth, ctrl.downtime);
router.get('/downtime/export/:format', auth, ctrl.exportDowntime);

/* Phase 2 · Screen 7 — Operator Performance. */
router.get('/operators', auth, ctrl.operators);
router.get('/operators/export/:format', auth, ctrl.exportOperators);

/* Phase 2 · Screen 8 — OEE Dashboard. */
router.get('/oee', auth, ctrl.oeeDashboard);
router.get('/oee/export/:format', auth, ctrl.exportOee);

/* Phase 2 · Screen 9 — Energy Monitoring. */
router.get('/energy', auth, ctrl.energy);
router.get('/energy/settings', auth, ctrl.getEnergySettings);
router.post('/energy/settings', auth, permit('page:dashboard'), ctrl.saveEnergySettings);
router.get('/energy/export/:format', auth, ctrl.exportEnergy);

router.get('/live/:machine_id', auth, ctrl.machineDetail);



module.exports = router;