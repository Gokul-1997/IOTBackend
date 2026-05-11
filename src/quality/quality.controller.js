const {
  getQualityDashboardService,
  upsertQualityEntryService
} = require("./quality.service");

const getQualityDashboard = async (req, res) => {
  try {
    const { machine_id, shift_id, date } = req.query;

    if (!machine_id || !shift_id || !date) {
      return res.status(400).json({
        success: false,
        message: "Missing required filters: machine_id, shift_id, date"
      });
    }

    const data = await getQualityDashboardService({ machine_id, shift_id, date });

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Quality Dashboard Error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

const upsertQualityEntry = async (req, res) => {
  try {
    const { machine_id, shift_id, date, reject_qty, rework_qty } = req.body;

    if (!machine_id || !shift_id || !date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: machine_id, shift_id, date"
      });
    }

    const result = await upsertQualityEntryService({
      machine_id,
      shift_id,
      date,
      reject_qty: reject_qty || 0,
      rework_qty: rework_qty || 0,
      user_id: req.user?.id || null
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("Quality Entry Error:", error);
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      message: status === 500 ? "Internal Server Error" : error.message
    });
  }
};

module.exports = {
  getQualityDashboard,
  upsertQualityEntry
};
