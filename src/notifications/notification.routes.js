const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./notification.controller');

router.get('/',            auth, ctrl.getNotifications);
router.get('/unread-count', auth, ctrl.getUnreadCount);
router.patch('/:id/read',   auth, ctrl.markRead);
router.post('/mark-all-read', auth, ctrl.markAllRead);

module.exports = router;
