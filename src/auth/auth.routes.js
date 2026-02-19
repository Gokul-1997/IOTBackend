const router = require('express').Router();
const ctrl = require('./auth.controller');

/* ============================
   AUTH
   ============================ */
router.post('/login', ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);

/* ============================
   PASSWORD RESET
   ============================ */
router.post('/forgot-password', ctrl.forgotPassword); // ✅ FIXED
router.post('/reset-password', ctrl.resetPassword);

module.exports = router;
