const svc = require('./dashboard.service');

/* =====================================================
   DASHBOARD (Paginated Machine Cards)
   GET /dashboard?page=1&per_page=6
===================================================== */
exports.dashboard = async (req, res) => {
  try {

    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.per_page) || 6;

    const data = await svc.dashboard(
      req.user.plant_id,
      page,
      perPage
    );

    return res.json({
      status: "success",
      ...data
    });

  } catch (err) {
    console.error("Dashboard Error:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to load dashboard"
    });
  }
};


/* =====================================================
   DASHBOARD SUMMARY (Header Counts)
   GET /dashboard/summary
===================================================== */
exports.dashboardSummary = async (req, res) => {
  try {

    const data = await svc.dashboardSummary(req.user.plant_id);

    return res.json({
      status: "success",
      ...data
    });

  } catch (err) {
    console.error("Dashboard Summary Error:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to load summary"
    });
  }
};


/* =====================================================
   MACHINE DETAIL
   GET /dashboard/:machine_id/detail
===================================================== */
exports.machineDetail = async (req, res) => {
  try {

    const machineId = parseInt(req.params.machine_id);

    if (!machineId) {
      return res.status(400).json({
        status: "error",
        message: "Invalid machine ID"
      });
    }

    const data = await svc.machineDetail(
      req.user.plant_id,
      machineId
    );

    return res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Machine Detail Error:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to load machine detail"
    });
  }
};


/* =====================================================
   MACHINE TIMELINE
   GET /dashboard/:machine_id/timeline
===================================================== */
exports.timeline = async (req, res) => {
  try {

    const machineId = parseInt(req.params.machine_id);

    if (!machineId) {
      return res.status(400).json({
        status: "error",
        message: "Invalid machine ID"
      });
    }

    const data = await svc.machineTimeline(machineId);

    return res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Timeline Error:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to load timeline"
    });
  }
};


/* =====================================================
   MACHINE TREND
   GET /dashboard/:machine_id/trend
===================================================== */
exports.trend = async (req, res) => {
  try {

    const machineId = parseInt(req.params.machine_id);

    if (!machineId) {
      return res.status(400).json({
        status: "error",
        message: "Invalid machine ID"
      });
    }

    const data = await svc.machineTrend(machineId);

    return res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Trend Error:", err);
    return res.status(500).json({
      status: "error",
      message: "Failed to load trend"
    });
  }
};