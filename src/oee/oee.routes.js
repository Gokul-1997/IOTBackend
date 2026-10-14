/**
 * OEE REPORTS ROUTES
 */

const express = require('express');
const router = express.Router();
const OeeController = require('./oee.controller');
const access = require('../middleware/access.middleware');
const auth = require('../middleware/auth.middleware');
const heavy = require('../middleware/heavy.middleware');

// Get metadata (machines, shifts, lines)
router.get('/meta', auth, OeeController.getMeta);

// Get OEE reports with filters and pagination
router.get('/reports', auth, access('page:oee-reports:view'), heavy, OeeController.getReports);

// Export to CSV
router.get('/export', auth, access('page:oee-reports:export'), heavy, OeeController.exportCSV);

module.exports = router;