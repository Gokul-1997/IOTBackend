const svc = require('./component.service');

exports.create = async (req, res, next) => {
  try {
    const result = await svc.create(req.body, req.user.plant_id, req.user.company_id);
    res.json(result);
  } catch (e) {
    next(e);
  }
};

exports.list = async (req, res, next) => {
  try {
    const result = await svc.list(req.user.plant_id, req.query, req.user.company_id);
    res.json(result);
  } catch (e) {
    next(e);
  }
};

exports.update = async (req, res, next) => {
  try {
    const result = await svc.update(
      req.params.id,
      req.body,
      req.user.plant_id,
      req.user.company_id
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const result = await svc.remove(
      req.params.id,
      req.user.plant_id,
      req.user.company_id
    );
    res.json(result);
  } catch (e) {
    next(e);
  }
};
