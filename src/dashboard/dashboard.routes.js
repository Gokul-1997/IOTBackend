const router = require('express').Router();
const ctrl = require('./dashboard.controller');
const auth = require('../middleware/auth.middleware');


router.get('/', auth, ctrl.dashboard);


router.get('/live/:machine_id', auth, ctrl.machineDetail);



module.exports = router;