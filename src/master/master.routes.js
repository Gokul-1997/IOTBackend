const express = require("express");
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const controller = require('./master.controller');

router.get("/machines", auth, controller.getMachineList);
router.get("/shifts", auth, controller.getShiftList);
router.get('/machines-by-line', auth, controller.getMachinesByLine);
/* POST /test-multi is gone. It let any signed-in user write any machine's live
   state in Redis — another company's machines included — which both the live
   screens and the collector's next reading build on. Nothing in the web app
   called it. */

module.exports = router;