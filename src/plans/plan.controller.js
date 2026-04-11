const svc = require('./plan.service');

exports.list = async (req, res, next) => {
  try { res.json(await svc.list()); } catch (e) { next(e); }
};

exports.getById = async (req, res, next) => {
  try { res.json(await svc.getById(req.params.id)); } catch (e) { next(e); }
};

exports.create = async (req, res, next) => {
  try { res.status(201).json(await svc.create(req.body)); } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try { res.json(await svc.update(req.params.id, req.body)); } catch (e) { next(e); }
};

exports.listPermissions = async (req, res, next) => {
  try { res.json(await svc.listPermissions()); } catch (e) { next(e); }
};

exports.seedPermissions = async (req, res, next) => {
  try {
    await svc.seedPermissions();
    res.json({ message: 'Permissions seeded' });
  } catch (e) { next(e); }
};
