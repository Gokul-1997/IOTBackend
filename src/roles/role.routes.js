const router   = require('express').Router();
const ctrl     = require('./role.controller');
const auth     = require('../middleware/auth.middleware');
const roleMidd = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');
const audited = require('../middleware/audit.middleware');

const ADMINS = ['SNT_SUPER', 'COMPANY_ADMIN'];

// Seed page permissions (SNT_SUPER only, run once)
router.post('/pages/seed', auth, audited('role'), roleMidd(['SNT_SUPER']), ctrl.seedPages);

// List page permissions (used by frontend role editor)
router.get('/pages/list', auth, roleMidd(ADMINS), ctrl.listPermissions);

// List all permissions
router.get('/permissions/list', auth, roleMidd(ADMINS), ctrl.listPermissions);

// List roles (company-scoped)
router.get('/', auth, roleMidd(ADMINS), ctrl.list);

// Get role by ID
router.get('/:id', auth, roleMidd(ADMINS), ctrl.getById);

/* Creating, copying, editing and deleting roles is the company admin's.
   S&T reads roles (support) and sets what a company can use in Manage
   Access; the service refuses S&T on these routes with a message saying so,
   rather than the route hiding them, so S&T gets an explanation, not a 403
   with no reason. */

// Create a role for the caller's company
router.post('/', auth, audited('role'), roleMidd(ADMINS), validate({
  role_name: { required: true, minLength: 2, maxLength: 50, label: 'Role name' }
}), ctrl.create);

// Copy a default role (or one of the company's own) into a new company role
router.post('/:id/copy', auth, audited('role'), roleMidd(ADMINS), validate({
  role_name: { required: true, minLength: 2, maxLength: 50, label: 'Role name' }
}), ctrl.copy);

// Update role name/description
router.put('/:id', auth, audited('role'), roleMidd(ADMINS), ctrl.update);

// Assign permissions to role (plan-validated)
router.put('/:id/permissions', auth, audited('role'), roleMidd(ADMINS), validate({
  permission_ids: { required: true, type: 'array', label: 'Permission IDs' }
}), ctrl.assignPermissions);

// Assign roles to a user
router.post('/assign/:id', auth, audited('role'), roleMidd(ADMINS), validate({
  role_ids: { required: true, type: 'array', label: 'Role IDs' }
}), ctrl.assign);

// Delete role (only custom roles, not system roles)
router.delete('/:id', auth, audited('role'), roleMidd(ADMINS), ctrl.remove);

module.exports = router;
