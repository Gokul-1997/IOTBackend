const express = require("express");
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const controller = require('./master.controller');

router.get("/machines", auth, controller.getMachineList);
router.get("/shifts", auth, controller.getShiftList);
router.get('/machines-by-line', auth, controller.getMachinesByLine);
module.exports = router;