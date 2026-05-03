const router = require('express').Router();
const auth = require('../middleware/auth.middleware');
const ctrl = require('./plan.controller');

router.get('/',           auth, ctrl.getPlans);
router.post('/',          auth, ctrl.createPlan);
router.put('/:id',        auth, ctrl.updatePlan);
router.delete('/:id',     auth, ctrl.deletePlan);
router.get('/variance',   auth, ctrl.getVariance);

module.exports = router;
