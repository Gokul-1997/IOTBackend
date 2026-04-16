const express = require("express");
const router = express.Router();
const redis = require('../redis'); // ioredis instance

const auth = require('../middleware/auth.middleware');
const controller = require('./master.controller');

router.get("/machines", auth, controller.getMachineList);
router.get("/shifts", auth, controller.getShiftList);
router.get('/machines-by-line', auth, controller.getMachinesByLine);
// FIX: added auth middleware — was unauthenticated, allowed fake telemetry injection
router.post('/test-multi', auth, async (req, res) => {

  const machines = req.body.machines;

  for (const m of machines) {

    const payload = {
      machine_id: m.machine_id,
      plant_id: m.plant_id,
      machine_status: m.machine_status,
      rpm: m.rpm || 1000,
      feed_rate: m.feed_rate || 200,
      parts_count: m.parts_count || 5,
      received_at: Math.floor(Date.now() / 1000)  // epoch seconds, consistent with real MQTT telemetry
    };

    await redis.multi()
      .set(`machine:${m.machine_id}:live`, JSON.stringify(payload), 'EX', 120)
      .publish('machine_updates', JSON.stringify(payload))
      .exec();
  }

  res.json({ success: true });
});

module.exports = router;