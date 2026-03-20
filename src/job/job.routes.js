const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const controller = require('./job.controller');

router.post('/start', auth, validate({
  machine_id:          { required: true, label: 'Machine' },
  component_id:        { required: true, label: 'Component' },
  job_start:           { required: true, label: 'Job start time' },
  setting_time_start:  { required: true, label: 'Setting time start' },
  setting_time_end:    { required: true, label: 'Setting time end' }
}), controller.startJob);

router.post('/stop', auth, validate({
  machine_id: { required: true, label: 'Machine' }
}), controller.stopJob);
router.get('/current',auth, controller.getCurrentJobs);

module.exports = router;