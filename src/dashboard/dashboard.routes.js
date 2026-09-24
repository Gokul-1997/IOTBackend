const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');
const access = require('../middleware/access.middleware');

/* Each Phase 2 dashboard has a key of its own (see APP_MODULES). These routes
   were `auth` alone: any signed-in user of any company could call any of them,
   whatever their role and whatever Manage Access said the company had bought.
   The data was always scoped to the caller's own company, so nothing crossed a
   tenant boundary — but a revoked or never-purchased dashboard stayed fully
   available to anyone who typed the URL. */
const view   = mod => access(`page:analytics-${mod}:view`);
const export_ = mod => access(`page:analytics-${mod}:export`);


/* The original live dashboard keeps its original keys. */
router.get('/', auth, access('page:dashboard:view'), ctrl.dashboard);


router.get('/factory', auth, view('factory'), ctrl.factory);

router.get('/maintenance', auth, view('maintenance'), ctrl.maintenance);

/* Phase 2 · Screen 3 — Preventive Maintenance */
router.get('/preventive', auth, view('preventive'), ctrl.preventive);

/* Threshold rules: reading is part of the dashboard, but changing what
   raises tickets is an edit and is gated accordingly. */
router.get('/preventive/thresholds',        auth, view('preventive'), ctrl.listThresholds);
router.post('/preventive/thresholds',       auth, permit('page:maintenance:edit'), ctrl.saveThreshold);
router.delete('/preventive/thresholds/:id', auth, permit('page:maintenance:delete'), ctrl.deleteThreshold);
router.post('/preventive/run',              auth, permit('page:maintenance:edit'), ctrl.runPmEngine);

/* Phase 2 · Screen 4 — Periodic Maintenance.
   Literal segments before /:format so "schedules" is never read as one. */
router.get('/periodic', auth, view('periodic'), ctrl.periodic);

router.get('/periodic/schedules',        auth, view('periodic'), ctrl.listPeriodicSchedules);
router.post('/periodic/schedules',       auth, permit('page:maintenance:edit'),   ctrl.savePeriodicSchedule);
router.delete('/periodic/schedules/:id', auth, permit('page:maintenance:delete'), ctrl.deletePeriodicSchedule);
router.post('/periodic/run',             auth, permit('page:maintenance:edit'),   ctrl.runPeriodicEngine);

router.get('/periodic/export/:format', auth, export_('periodic'), ctrl.exportPeriodic);

/* Phase 2 · Screen 5 — Alarm Dashboard & Reports. */
router.get('/alarms', auth, view('alarms'), ctrl.alarms);
router.get('/alarms/export/:format', auth, export_('alarms'), ctrl.exportAlarms);

/* Phase 2 · Screen 6 — Downtime Reason Loss Analysis. */
router.get('/downtime', auth, view('downtime'), ctrl.downtime);
router.get('/downtime/export/:format', auth, export_('downtime'), ctrl.exportDowntime);

/* Phase 2 · Screen 7 — Operator Performance. */
router.get('/operators', auth, view('operators'), ctrl.operators);
router.get('/operators/export/:format', auth, export_('operators'), ctrl.exportOperators);

/* Phase 2 · Screen 8 — OEE Dashboard. */
router.get('/oee', auth, view('oee'), ctrl.oeeDashboard);
router.get('/oee/export/:format', auth, export_('oee'), ctrl.exportOee);

/* Phase 2 · Screen 9 — Energy Monitoring. */
router.get('/energy', auth, view('energy'), ctrl.energy);
router.get('/energy/settings', auth, view('energy'), ctrl.getEnergySettings);
/* Was permit('page:dashboard') — an exact match against a key that has never
   existed in the permissions table (only page:dashboard:view and the widget
   keys do), so it could not pass for any company user. Saving a tariff worked
   for SNT_SUPER alone, who has no company to save one for. */
router.post('/energy/settings', auth, access('page:analytics-energy:settings'), ctrl.saveEnergySettings);
router.get('/energy/export/:format', auth, export_('energy'), ctrl.exportEnergy);

/* Maintenance Report — the ticket record over a period, exportable.
   Its own key, not page:analytics-maintenance: the dashboard shows live
   machine condition and this shows what maintenance did, and a company can
   reasonably be sold one without the other. */
router.get('/maintenance-report', auth, access('page:maintenance-report:view'), ctrl.maintenanceReport);
router.get('/maintenance-report/export/:format', auth, access('page:maintenance-report:export'), ctrl.exportMaintenanceReport);

router.get('/live/:machine_id', auth, access('page:dashboard:live:view'), ctrl.machineDetail);
router.get('/live/:machine_id/timeline', auth, access('page:dashboard:live:view'), ctrl.machineTimeline);



module.exports = router;