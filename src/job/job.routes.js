const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const controller = require('./job.controller');

router.post('/start', auth, validate({
  machine_id:   { required: true, label: 'Machine' },
  component_id: { required: true, label: 'Component' },
  job_start:    { required: true, label: 'Job start time' }
}), controller.startJob);

router.post('/stop', auth, validate({
  machine_id: { required: true, label: 'Machine' }
}), controller.stopJob);
router.get('/available-machines', auth, controller.getAvailableMachines);
router.get('/current', auth, controller.getCurrentJobs);
router.get('/history', auth, controller.getJobHistory);

module.exports = router;