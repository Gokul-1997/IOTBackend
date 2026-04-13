const svc = require('./company.service');

exports.create = async (req, res, next) => {
  try {
    const company = await svc.create(req.body);
    res.status(201).json(company);
  } catch (e) { next(e); }
};

exports.list = async (req, res, next) => {
  try {
    res.json(await svc.list());
  } catch (e) { next(e); }
};

exports.getById = async (req, res, next) => {
  try {
    res.json(await svc.getById(req.params.id));
  } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try {
    res.json(await svc.update(req.params.id, req.body));
  } catch (e) { next(e); }
};

exports.assignPlan = async (req, res, next) => {
  try {
    res.json(await svc.assignPlan(req.params.id, req.body));
  } catch (e) { next(e); }
};

exports.getPlanFeatures = async (req, res, next) => {
  try {
    res.json(await svc.getPlanFeatures(req.params.id));
  } catch (e) { next(e); }
};

exports.getCompanyPermissions = async (req, res, next) => {
  try {
    res.json(await svc.getCompanyPermissions(req.params.id));
  } catch (e) { next(e); }
};

exports.assignCompanyPermissions = async (req, res, next) => {
  try {
    res.json(await svc.assignCompanyPermissions(req.params.id, req.body.permission_ids, req.user.id));
  } catch (e) { next(e); }
};

exports.remove = async (req, res, next) => {
  try {
    await svc.remove(req.params.id);
    res.json({ message: 'Company deactivated' });
  } catch (e) { next(e); }
};

exports.permanentDelete = async (req, res, next) => {
  try {
    await svc.permanentDelete(req.params.id);
    res.json({ message: 'Company permanently deleted' });
  } catch (e) { next(e); }
};
