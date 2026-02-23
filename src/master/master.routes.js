const express = require("express");
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const controller = require('./master.controller');

router.get("/machines", auth, controller.getMachineList);
router.get("/shifts", auth, controller.getShiftList);

module.exports = router;