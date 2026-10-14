const express = require('express');
const router = express.Router();
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const controller = require('./job.controller');

router.post('/start', auth, access('page:job:create'), validate({
  machine_id:   { required: true, label: 'Machine' },
  component_id: { required: true, label: 'Component' },
  job_start:    { required: true, label: 'Job start time' }
}), controller.startJob);

router.post('/stop', auth, access('page:job:delete'), validate({
  machine_id: { required: true, label: 'Machine' }
}), controller.stopJob);
router.get('/available-machines', auth, access('page:job:view'), controller.getAvailableMachines);
router.get('/current', auth, access('page:job:view'), controller.getCurrentJobs);
router.get('/history', auth, access('page:job:view'), controller.getJobHistory);

module.exports = router;