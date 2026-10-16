const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const access = require('../middleware/access.middleware');
const role = require('../middleware/role.middleware');
const ctrl = require('./alarm.controller');

const alarmPageAccess = access.any('page:alarms:view', 'page:analytics-alarms:view', 'page:dashboard:view');
router.get('/notification-policy', auth, role(['COMPANY_ADMIN', 'ADMIN']), alarmPageAccess, ctrl.getNotificationPolicy);
router.put('/notification-policy', auth, role(['COMPANY_ADMIN', 'ADMIN']), alarmPageAccess, ctrl.updateNotificationPolicy);
router.get('/notification-rules', auth, role(['COMPANY_ADMIN', 'ADMIN']), alarmPageAccess, ctrl.retiredNotificationRules);
router.put('/notification-rules/:machineId', auth, role(['COMPANY_ADMIN', 'ADMIN']), alarmPageAccess, ctrl.retiredNotificationRules);

/* The Alarms page's own keys (APP_MODULES "alarms": view, resolve). Every
   route used to check only that the caller was signed in, so any role could
   list and resolve alarms through the API — the mobile app offered Resolve
   to everyone — and any user could change the company's alert settings. */
router.get('/', auth, access('page:alarms:view'), ctrl.getAlarms);
router.patch('/:id/resolve', auth, access('page:alarms:resolve'), ctrl.resolveAlarm);
router.get('/preferences', auth, role(['COMPANY_ADMIN', 'ADMIN']), ctrl.getPreferences);
router.put('/preferences', auth, role(['COMPANY_ADMIN', 'ADMIN']), ctrl.updatePreferences);

module.exports = router;
