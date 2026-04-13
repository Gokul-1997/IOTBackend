const express    = require('express');
const router     = express.Router();
const auth = require('../middleware/auth.middleware');
const svc        = require('./charts.service');

/* GET /api/charts/meta */
router.get('/meta', auth, async (req, res) => {
  try {
    const data = await svc.getMeta(req.user.plant_id, req.user.company_id);
    res.json({ success: true, data });
  } catch (err) {
    console.error('charts/meta error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* GET /api/charts/data?machine_id=&shift_id=&date= */
router.get('/data', auth, async (req, res) => {
  try {
    const { machine_id, shift_id, date } = req.query;
    const today = new Date().toISOString().split('T')[0];

    const data = await svc.getChartData({
      plantId:   req.user.plant_id,
      companyId: req.user.company_id,
      machineId: machine_id || null,
      shiftId:   shift_id   || null,
      date:      date       || today
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('charts/data error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* GET /api/charts/parts?machine_id=&shift_start_epoch= */
router.get('/parts', auth, async (req, res) => {
  try {
    const { machine_id, shift_start_epoch, shift_end_epoch, max_parts } = req.query;
    if (!machine_id) return res.status(400).json({ success: false, message: 'machine_id required' });

    const data = await svc.getPartTiming({
      machineId:       machine_id,
      shiftStartEpoch: shift_start_epoch || Math.floor(Date.now() / 1000) - 28800, // default 8h ago
      shiftEndEpoch:   shift_end_epoch   || null,
      maxParts:        max_parts         ? Number(max_parts) : null
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('charts/parts error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
