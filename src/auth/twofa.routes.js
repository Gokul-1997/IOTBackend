const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./twofa.controller');

router.get('/status',  auth, ctrl.getStatus);
router.post('/setup',  auth, ctrl.setup);
router.post('/enable', auth, ctrl.enable);
router.post('/disable', auth, ctrl.disable);
router.post('/verify', auth, ctrl.verify);

module.exports = router;
