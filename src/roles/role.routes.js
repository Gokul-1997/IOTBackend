const router = require('express').Router();
const ctrl = require('./role.controller');
const auth = require('../middleware/auth.middleware');
const role = require('../middleware/role.middleware');
const validate = require('../middleware/validate.middleware');

// List all roles with their permissions (ADMIN only)
router.get('/', auth, role(['ADMIN']), ctrl.list);

// Get all available permissions (ADMIN only)
router.get('/permissions/list', auth, role(['ADMIN']), ctrl.listPermissions);

// Get page permissions grouped (ADMIN only)
router.get('/pages/list', auth, role(['ADMIN']), ctrl.listPages);

// Seed page permissions into DB (ADMIN only, run once)
router.post('/pages/seed', auth, role(['ADMIN']), ctrl.seedPages);

// Get role by ID (ADMIN only)
router.get('/:id', auth, role(['ADMIN']), ctrl.getById);

// Create role (ADMIN only)
router.post('/', auth, role(['ADMIN']), validate({
  role_name: { required: true, maxLength: 50, label: 'Role name' }
}), ctrl.create);

// Assign roles to user — MUST be before /:id routes (ADMIN only)
router.post('/assign/:id', auth, role(['ADMIN']), validate({
  role_ids: { required: true, type: 'array', label: 'Role IDs' }
}), ctrl.assign);

// Assign permissions to role (ADMIN only)
router.put('/:id/permissions', auth, role(['ADMIN']), validate({
  permission_ids: { required: true, type: 'array', label: 'Permission IDs' }
}), ctrl.assignPermissions);

// Delete role (ADMIN only)
router.delete('/:id', auth, role(['ADMIN']), ctrl.remove);

module.exports = router;
