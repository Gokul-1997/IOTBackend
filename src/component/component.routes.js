const router = require('express').Router();
const ctrl = require('./component.controller');
const auth = require('../middleware/auth.middleware');
const permit = require('../middleware/permission.middleware');

// router.post('/', auth, permit('component.create'), ctrl.create);
// router.get('/', auth, permit('component.view'), ctrl.list);
// router.put('/:id', auth, permit('component.update'), ctrl.update);
// router.delete('/:id', auth, permit('component.delete'), ctrl.remove);


router.post('/', auth,  ctrl.create);
router.get('/', auth, ctrl.list);
router.put('/:id', auth, ctrl.update);
router.delete('/:id', auth, ctrl.remove);

module.exports = router;