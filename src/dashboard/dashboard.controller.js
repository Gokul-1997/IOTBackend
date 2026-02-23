const svc = require('./dashboard.service');

exports.dashboard = async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const data = await svc.dashboardPaged(req.user.plant_id, Number(page), 6);

       res.json({ success: true, ...data });


  } catch (err) {
    console.error("Dashboard Error:", err);
    res.status(500).json({ status: "error" });
  }
};

exports.machineDetail = async (req, res) => {
  try {
    const data = await svc.machineDetail(
      req.user.plant_id,
      req.params.machine_id
    );

    res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Machine Detail Error:", err);
    res.status(500).json({ status: "error" });
  }
};

exports.liveSingle = async (req, res) => {
  try {
    const data = await svc.machineLive(req.params.machine_id);

    res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Live Error:", err);
    res.status(500).json({ status: "error" });
  }
};

exports.timeline = async (req, res) => {
  try {
    const data = await svc.machineTimeline(req.params.machine_id);

    res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Timeline Error:", err);
    res.status(500).json({ status: "error" });
  }
};

exports.trend = async (req, res) => {
  try {
    const data = await svc.machineTrend(req.params.machine_id);

    res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Trend Error:", err);
    res.status(500).json({ status: "error" });
  }
};

exports.dashboardSummary = async (req, res) => {
  try {
    const data = await svc.dashboardSummary(req.user.plant_id);

    res.json({
      status: "success",
      data
    });

  } catch (err) {
    console.error("Dashboard Summary Error:", err);
    res.status(500).json({ status: "error" });
  }
};