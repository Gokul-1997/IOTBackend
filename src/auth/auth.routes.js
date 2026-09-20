const router = require('express').Router();
const ctrl = require('./auth.controller');
const validate = require('../middleware/validate.middleware');
const auth = require('../middleware/auth.middleware');

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
   SELF-SERVICE PROFILE (any authenticated user, own account only)
   ============================ */
router.get('/me',    auth, ctrl.getMyProfile);
router.patch('/me',  auth, ctrl.updateMyProfile);
router.post('/change-password', auth, validate({
  current_password: { required: true, label: 'Current password' },
  new_password:      { required: true, minLength: 8, label: 'New password' }
}), ctrl.changeMyPassword);

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
