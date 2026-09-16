const router     = require('express').Router();
const auth       = require('../middleware/auth.middleware');
const isSNT      = require('../middleware/snt.middleware');
const ctrl       = require('./company.controller');
const checkQuota = require('../middleware/quota.middleware');
const validate   = require('../middleware/validate.middleware');
const audited = require('../middleware/audit.middleware');

// All company management is SNT_SUPER only (except GET own company)
router.post('/',                      auth, audited('company'), isSNT,  ctrl.create);
router.get('/',                       auth, isSNT,  ctrl.list);
router.get('/:id',                    auth,          ctrl.getById);
router.put('/:id',                    auth, audited('company'), isSNT,  ctrl.update);
router.post('/:id/plan',              auth, audited('company'), isSNT,  ctrl.assignPlan);
router.get('/:id/plan/history',       auth, isSNT,  ctrl.getPlanHistory);
router.get('/:id/plan-features',      auth,          ctrl.getPlanFeatures);
// Usage against the plan's limits. Any authenticated user may read it for
// their own company; the service refuses another company's figures.
router.get('/:id/usage',              auth,          ctrl.getUsage);
router.get('/:id/permissions',        auth,          ctrl.getCompanyPermissions);
router.put('/:id/permissions',        auth, audited('company'), isSNT,  ctrl.assignCompanyPermissions);
router.delete('/:id',                 auth, audited('company'), isSNT,  ctrl.remove);
router.delete('/:id/permanent',       auth, audited('company'), isSNT,  ctrl.permanentDelete);

/* ── Plant management under a company (SNT_SUPER only) ── */

// Inject target company_id so checkQuota works correctly for SNT_SUPER
const injectCompanyId = (req, res, next) => {
  req.user.company_id = req.params.id;
  next();
};

router.get('/:id/plants',
  auth, isSNT, ctrl.getCompanyPlants);

router.post('/:id/plants',
  auth, isSNT, injectCompanyId, checkQuota('plants'),
  audited('company'),
  validate({
    plant_code: { required: true, maxLength: 20,  label: 'Plant code' },
    plant_name: { required: true, maxLength: 100, label: 'Plant name' }
  }),
  ctrl.createCompanyPlant);

/* audited() belongs inside the call. It used to sit after the closing
   paren as a stray expression, so both of these ran with no audit log at
   all while still parsing — the server booted and nothing complained. */
router.put('/:id/plants/:plant_id',
  auth, isSNT, audited('company'), ctrl.updateCompanyPlant);

router.patch('/:id/plants/:plant_id/status',
  auth, isSNT, audited('company'), ctrl.toggleCompanyPlantStatus);

module.exports = router;
