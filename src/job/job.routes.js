const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');

const controller = require('./job.controller');

router.post('/start',auth, controller.startJob);
router.post('/stop',auth, controller.stopJob);
router.get('/current',auth, controller.getCurrentJobs);

module.exports = router;