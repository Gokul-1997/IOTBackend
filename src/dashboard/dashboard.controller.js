const svc = require('./dashboard.service');

/* =====================================================
   DASHBOARD (Paginated Machine Cards)
   GET /dashboard?page=1&per_page=6
===================================================== */
exports.dashboard = async (req, res) => {
  try {

    const data = await svc.dashboard(req.user.plant_id);

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