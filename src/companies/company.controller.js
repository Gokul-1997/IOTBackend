const svc      = require('./company.service');
const plantSvc = require('../plants/plant.service');
const checkQuota = require('../middleware/quota.middleware');

/* company.routes.js says "SNT_SUPER only (except GET own company)" — but
   nothing enforced the exception's other half. getById, getPlanFeatures and
   getCompanyPermissions took req.params.id and ran it, so any authenticated
   user could read any company's contact details, plan and page access by
   changing an integer in the URL. getUsage already did this check (below);
   these now share it. Answered before touching the database, and as a 403
   rather than a 404 because a company id is not a secret the way a role id
   guessed by an attacker is — the list of companies is one click away for
   anyone who can see the admin screen. */
function ownCompanyOrSuper(req, res) {
  const id = Number(req.params.id);
  if (!req.user.is_snt_super && req.user.company_id !== id) {
    res.status(403).json({ message: 'You may only view your own company' });
    return false;
  }
  return true;
}

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
    if (!ownCompanyOrSuper(req, res)) return;
    res.json(await svc.getById(req.params.id));
  } catch (e) { next(e); }
};

exports.update = async (req, res, next) => {
  try {
    res.json(await svc.update(req.params.id, req.body));
  } catch (e) { next(e); }
};

/* The audit trail the agreement asks for: every plan change on a company,
   who made it and what it replaced. */
exports.getUsage = async (req, res, next) => {
  try {
    /* A company admin may only read their own company's usage; a super
       user may read any. Without this, the id in the URL would be enough
       to read another tenant's headcount and machine estate. */
    const id = Number(req.params.id);
    if (!req.user.is_snt_super && req.user.company_id !== id) {
      return res.status(403).json({ message: 'You may only view your own company usage' });
    }
    res.json(await svc.getUsage(id));
  } catch (e) { next(e); }
};

exports.getPlanHistory = async (req, res, next) => {
  try {
    const result = await svc.getPlanHistory(req.params.id, req.query);
    res.json({ status: 'success', ...result });
  } catch (e) { next(e); }
};

exports.assignPlan = async (req, res, next) => {
  try {
    // req.user.id is what makes the history answer "who authorised this?"
    res.json(await svc.assignPlan(req.params.id, req.body, req.user.id));
  } catch (e) { next(e); }
};

exports.getPlanFeatures = async (req, res, next) => {
  try {
    if (!ownCompanyOrSuper(req, res)) return;
    res.json(await svc.getPlanFeatures(req.params.id));
  } catch (e) { next(e); }
};

exports.getCompanyPermissions = async (req, res, next) => {
  try {
    if (!ownCompanyOrSuper(req, res)) return;
    res.json(await svc.getCompanyPermissions(req.params.id));
  } catch (e) { next(e); }
};

exports.assignCompanyPermissions = async (req, res, next) => {
  try {
    res.json(await svc.assignCompanyPermissions(Number(req.params.id), req.body.permission_ids, req.user.id));
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
