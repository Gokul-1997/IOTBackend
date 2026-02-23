const express = require("express");
const router = express.Router();

const auth = require('../middleware/auth.middleware');
const controller = require('./quality.controller');


router.get("/", auth, controller.getQualityDashboard);

module.exports = router;