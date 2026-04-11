const router = require('express').Router();
const auth   = require('../middleware/auth.middleware');
const isSNT  = require('../middleware/snt.middleware');
const ctrl   = require('./company.controller');

// All company management is SNT_SUPER only (except GET own company)
router.post('/',                      auth, isSNT,  ctrl.create);
router.get('/',                       auth, isSNT,  ctrl.list);
router.get('/:id',                    auth,          ctrl.getById);
router.put('/:id',                    auth, isSNT,  ctrl.update);
router.post('/:id/plan',              auth, isSNT,  ctrl.assignPlan);
router.get('/:id/plan-features',      auth,          ctrl.getPlanFeatures);
router.delete('/:id',                 auth, isSNT,  ctrl.remove);

module.exports = router;
