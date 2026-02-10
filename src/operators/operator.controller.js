const svc = require('./operator.service');

exports.create = async (req, res, next) => {
  try {
    const result = await svc.create(req.body, req.user.plant_id);
    res.json(result);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const result = await svc.list(req.user.plant_id, req.query);
    res.json(result);
  } catch (e) {
    next(e);
  }
};
