const router = require('express').Router();
const ctrl = require('./auth.controller');
const validate = require('../middleware/validate.middleware');

/* ============================
   AUTH
   ============================ */
router.post('/login', validate({
  email:    { required: true, email: true, label: 'Email' },
  password: { required: true, label: 'Password' }
}), ctrl.login);

router.post('/refresh', ctrl.refresh);
router.post('/logout',  ctrl.logout);

/* ============================
   PASSWORD RESET
   ============================ */
router.post('/forgot-password', validate({
  email: { required: true, email: true, label: 'Email' }
}), ctrl.forgotPassword);

router.post('/reset-password', validate({
  token:    { required: true, label: 'Token' },
  password: { required: true, minLength: 8, label: 'Password' }
}), ctrl.resetPassword);

module.exports = router;
