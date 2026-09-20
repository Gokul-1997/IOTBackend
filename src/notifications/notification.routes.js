const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./notification.controller');

router.get('/',            auth, ctrl.getNotifications);
router.get('/unread-count', auth, ctrl.getUnreadCount);
router.patch('/:id/read',   auth, ctrl.markRead);
router.post('/mark-all-read', auth, ctrl.markAllRead);

/* Registered before any /:id route would exist to collide with it — there
   is none here, but keeping literal segments first is the house pattern
   (see programs/program.routes.js). */
router.get('/preferences', auth, ctrl.getPreferences);
router.put('/preferences', auth, ctrl.updatePreferences);

module.exports = router;
