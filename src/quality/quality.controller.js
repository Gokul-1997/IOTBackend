const {
  getQualityDashboardService
} = require("./quality.service");

const getQualityDashboard = async (req, res) => {
  try {
    const { machine_id, shift_id, from, to } = req.query;

    if (!machine_id || !shift_id || !from || !to) {
      return res.status(400).json({
        success: false,
        message: "Missing required filters"
      });
    }

    const data = await getQualityDashboardService({
      machine_id,
      shift_id,
      from,
      to
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
};

module.exports = {
  getQualityDashboard
};