const service = require('./user.service');

exports.create = async (req, res) => {
  res.json(await service.create(req.body, req.user.plant_id));
};

exports.list = async (req, res) => {
  res.json(await service.list(req.user.plant_id));
};
