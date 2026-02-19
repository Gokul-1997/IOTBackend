const svc = require('./ai.service');

exports.machineRisk = async (req, res) => {
  res.json(await svc.machineRisk(req.user.plant_id));
};
