const svc = require('./operator.service');

exports.create = async (req, res) => {
  res.json(await svc.create(req.body, req.user.plant_id));
};

exports.list = async (req, res) => {
  res.json(await svc.list(req.user.plant_id));
};
