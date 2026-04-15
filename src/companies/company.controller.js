const svc      = require('./company.service');
const plantSvc = require('../plants/plant.service');
const checkQuota = require('../middleware/quota.middleware');

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

/* ─────────────────────────────────────────────────────────
   PLANT MANAGEMENT under a company (SNT_SUPER only)
   GET    /companies/:id/plants
   POST   /companies/:id/plants
   PUT    /companies/:id/plants/:plant_id
   PATCH  /companies/:id/plants/:plant_id/status
───────────────────────────────────────────────────────── */

exports.getCompanyPlants = async (req, res, next) => {
  try {
    const result = await plantSvc.getPlants(req.params.id, req.query);
    res.json(result);
  } catch (e) { next(e); }
};

exports.createCompanyPlant = async (req, res, next) => {
  try {
    const plant = await plantSvc.createPlant(req.body, req.params.id);
    res.status(201).json({ message: 'Plant created', plant });
  } catch (e) { next(e); }
};

exports.updateCompanyPlant = async (req, res, next) => {
  try {
    const plant = await plantSvc.updatePlant(req.params.plant_id, req.body, req.params.id);
    res.json({ message: 'Plant updated', plant });
  } catch (e) { next(e); }
};

exports.toggleCompanyPlantStatus = async (req, res, next) => {
  try {
    await plantSvc.togglePlantStatus(req.params.plant_id, req.body.is_active, req.params.id);
    res.json({ message: 'Status updated' });
  } catch (e) { next(e); }
};
