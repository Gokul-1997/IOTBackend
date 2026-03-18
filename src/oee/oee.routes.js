/**
 * OEE REPORTS ROUTES
 */

const express = require('express');
const router = express.Router();
const OeeController = require('./oee.controller');
const auth = require('../middleware/auth.middleware');

// Get metadata (machines, shifts, lines)
router.get('/meta', auth, OeeController.getMeta);

// Get OEE reports with filters and pagination
router.get('/reports', auth, OeeController.getReports);

// Export to CSV
router.get('/export', auth, OeeController.exportCSV);

module.exports = router;