const express = require('express');
const router = express.Router();
const OeeController = require('./oee.controller');
const auth = require('../middleware/auth.middleware');

router.get('/meta',auth, OeeController.getMeta);
router.get('/reports', auth, OeeController.getReports);

module.exports = router;
