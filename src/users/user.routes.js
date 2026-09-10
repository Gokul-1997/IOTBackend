const router = require('express').Router();
const ctrl = require('./user.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const checkQuota = require('../middleware/quota.middleware');

// List all users (ADMIN only)
router.get('/', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN']), ctrl.list);

// Get user by ID (ADMIN only)
router.get('/:id', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN']), ctrl.getById);

// Create user (ADMIN only)
/* The plan's user limit is enforced here. The quota middleware has
   supported 'users' since it was written — its own docstring shows the
   call — but it was never applied, so a Bronze company capped at 10
   users could create as many as it liked. */
router.post('/', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN']), checkQuota('users'), validate({
  username: { required: true, minLength: 3, maxLength: 50, label: 'Username' },
  email: { required: true, label: 'Email' },
  password: { required: true, minLength: 8, label: 'Password' },
  role_ids: { label: 'Role IDs' }
}), ctrl.create);

// Update user (ADMIN only)
router.put('/:id', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN']), validate({
  username: { minLength: 3, maxLength: 50, label: 'Username' },
  email: { label: 'Email' },
  password: { minLength: 8, label: 'Password' },
  is_active: { label: 'Active Status' }
}, { partial: true }), ctrl.update);

// Delete user (soft-delete, sets is_active=false) (ADMIN only)
router.delete('/:id', auth, role(['SNT_SUPER', 'COMPANY_ADMIN', 'ADMIN']), ctrl.remove);

module.exports = router;
