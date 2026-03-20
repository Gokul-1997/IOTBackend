const express = require("express");
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const validate = require('../middleware/validate.middleware');
const controller = require('./quality.controller');

router.get("/", auth, controller.getQualityDashboard);
router.post("/entry", auth, validate({
  machine_id:  { required: true, label: 'Machine' },
  shift_id:    { required: true, label: 'Shift' },
  date:        { required: true, label: 'Date' },
  reject_qty:  { type: 'number', min: 0, label: 'Reject quantity' },
  rework_qty:  { type: 'number', min: 0, label: 'Rework quantity' }
}), controller.upsertQualityEntry);

module.exports = router;
