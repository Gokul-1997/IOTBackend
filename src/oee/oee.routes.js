/**
 * OEE REPORTS ROUTES
 */

const express = require('express');
const router = express.Router();
const OeeController = require('./oee.controller');
const auth = require('../middleware/auth.middleware');
const heavy = require('../middleware/heavy.middleware');

// Get metadata (machines, shifts, lines)
router.get('/meta', auth, OeeController.getMeta);

// Get OEE reports with filters and pagination
router.get('/reports', auth, heavy, OeeController.getReports);

// Export to CSV
router.get('/export', auth, heavy, OeeController.exportCSV);

module.exports = router;