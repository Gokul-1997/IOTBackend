const express    = require('express');
const router     = express.Router();
const auth = require('../middleware/auth.middleware');
const svc        = require('./charts.service');
const heavy      = require('../middleware/heavy.middleware');

/* GET /api/charts/meta */
router.get('/meta', auth, async (req, res, next) => {
  try {
    const data = await svc.getMeta(req.user.plant_id, req.user.company_id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/* GET /api/charts/data?machine_id=&shift_id=&date= */
router.get('/data', auth, async (req, res, next) => {
  try {
    const { machine_id, shift_id, date } = req.query;
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toISOString().split('T')[0];

    const data = await svc.getChartData({
      plantId:   req.user.plant_id,
      companyId: req.user.company_id,
      machineId: machine_id || null,
      shiftId:   shift_id   || null,
      date:      date       || today
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/* GET /api/charts/parts?machine_id=&shift_start_epoch= */
router.get('/parts', auth, heavy, async (req, res, next) => {
  try {
    const { machine_id, shift_start_epoch, shift_end_epoch, max_parts } = req.query;
    if (!machine_id) return res.status(400).json({ success: false, message: 'machine_id required' });

    const result = await svc.getPartTiming({
      companyId:       req.user.company_id,
      machineId:       machine_id,
      shiftStartEpoch: shift_start_epoch || Math.floor(Date.now() / 1000) - 28800, // default 8h ago
      shiftEndEpoch:   shift_end_epoch   || null,
      maxParts:        max_parts         ? Number(max_parts) : null
    });

    // Keep data as a plain array so res.data stays array-compatible.
    // Totals go at the response root level.
    res.json({
      success:      true,
      data:         result.parts,
      totalRunMin:  result.totalRunMin,
      totalIdleMin: result.totalIdleMin
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
