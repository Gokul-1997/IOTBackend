const svc = require('./telemetry.service');

exports.push = async (req, res) => {
  await svc.insert(req.machine, req.body);
  res.json({ success: true });
};
