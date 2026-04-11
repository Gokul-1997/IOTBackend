const router   = require('express').Router();
const ctrl     = require('./role.controller');
const auth     = require('../middleware/auth.middleware');
const roleMidd = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');

const ADMINS = ['SNT_SUPER', 'COMPANY_ADMIN'];

// Seed page permissions (SNT_SUPER only, run once)
router.post('/pages/seed', auth, roleMidd(['SNT_SUPER']), ctrl.seedPages);

// List page permissions (used by frontend role editor)
router.get('/pages/list', auth, roleMidd(ADMINS), ctrl.listPermissions);

// List all permissions
router.get('/permissions/list', auth, roleMidd(ADMINS), ctrl.listPermissions);

// List roles (company-scoped)
router.get('/', auth, roleMidd(ADMINS), ctrl.list);

// Get role by ID
router.get('/:id', auth, roleMidd(ADMINS), ctrl.getById);

// Create role (COMPANY_ADMIN creates for their company; SNT_SUPER can create anywhere)
router.post('/', auth, roleMidd(ADMINS), validate({
  role_name: { required: true, maxLength: 100, label: 'Role name' }
}), ctrl.create);

// Update role name/description
router.put('/:id', auth, roleMidd(ADMINS), ctrl.update);

// Assign permissions to role (plan-validated)
router.put('/:id/permissions', auth, roleMidd(ADMINS), validate({
  permission_ids: { required: true, type: 'array', label: 'Permission IDs' }
}), ctrl.assignPermissions);

// Assign roles to a user
router.post('/assign/:id', auth, roleMidd(ADMINS), validate({
  role_ids: { required: true, type: 'array', label: 'Role IDs' }
}), ctrl.assign);

// Delete role (only custom roles, not system roles)
router.delete('/:id', auth, roleMidd(ADMINS), ctrl.remove);

module.exports = router;
