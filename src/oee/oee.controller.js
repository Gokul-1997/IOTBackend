const OeeService = require('./oee.service');

exports.getMeta = async (req, res) => {
  try {
    const data = await OeeService.getMeta(req.user.plant_id);
    res.json({ status: 'success', data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Failed to load meta' });
  }
};

exports.getReports = async (req, res) => {
  try {
    const result = await OeeService.getReports(req.query, req.user.plant_id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'Failed to load reports' });
  }
};
