const router = require('express').Router();
const auth   = require('../middleware/auth.middleware');
const isSNT  = require('../middleware/snt.middleware');
const ctrl   = require('./plan.controller');

router.get('/permissions',            auth, ctrl.listPermissions);
router.post('/permissions/seed',      auth, isSNT, ctrl.seedPermissions);

router.get('/',                       auth, ctrl.list);
router.get('/:id',                    auth, ctrl.getById);
router.post('/',                      auth, isSNT, ctrl.create);
router.put('/:id',                    auth, isSNT, ctrl.update);

module.exports = router;
