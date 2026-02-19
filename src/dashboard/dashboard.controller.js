const svc = require('./dashboard.service');

exports.dashboard = async (req, res) => {
  try {
    const { page = 1 } = req.query;

    const data = await svc.dashboardPaged({
      plant_id: req.user.plant_id,
      page: Number(page),
      limit: 6
    });

    res.json({ success: true, ...data });
  } catch (err) {
    console.error('Dashboard Error:', err);
    res.status(500).json({ success: false });
  }
};

exports.machineDetail = async (req, res) => {
  try {
    const data = await svc.machineDetail(
      req.user.plant_id,
      req.params.machine_id
    );

    res.json({ success: true, data });
  } catch (err) {
    console.error('Machine Detail Error:', err);
    res.status(500).json({ success: false });
  }
};

exports.liveSingle = async (req, res) => {
  try {
    const data = await svc.machineLive(req.params.machine_id);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Live Error:', err);
    res.status(500).json({ success: false });
  }
};
