const service = require('./plan.service');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.getPlans      = wrap(async (req, res) => res.json({ success: true, ...(await service.getPlans({ company_id: req.user.company_id, ...req.query })) }));
exports.createPlan    = wrap(async (req, res) => res.status(201).json({ success: true, data: await service.createPlan({ company_id: req.user.company_id, created_by: req.user.id, ...req.body }) }));
exports.updatePlan    = wrap(async (req, res) => res.json({ success: true, data: await service.updatePlan(req.params.id, req.user.company_id, req.body) }));
exports.deletePlan    = wrap(async (req, res) => { await service.deletePlan(req.params.id, req.user.company_id); res.json({ success: true }); });
exports.getVariance   = wrap(async (req, res) => res.json({ success: true, data: await service.getVarianceReport({ company_id: req.user.company_id, ...req.query }) }));
