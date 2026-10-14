const service = require('./maintenance.service');

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); }
  catch (e) { next(e); }
};

exports.getSchedules   = wrap(async (req, res) => res.json({ success: true, ...(await service.getSchedules({ ...req.query, company_id: req.user.company_id, plant_id: req.plantScopeId })) }));
exports.createSchedule = wrap(async (req, res) => res.status(201).json({ success: true, data: await service.createSchedule({ ...req.body, company_id: req.user.company_id, plant_id: req.plantScopeId, created_by: req.user.id }) }));
exports.updateSchedule = wrap(async (req, res) => res.json({ success: true, data: await service.updateSchedule(req.params.id, req.user.company_id, req.body, req.plantScopeId) }));
exports.deleteSchedule = wrap(async (req, res) => { await service.deleteSchedule(req.params.id, req.user.company_id, req.plantScopeId); res.json({ success: true }); });
exports.getLogs        = wrap(async (req, res) => res.json({ success: true, ...(await service.getLogs({ ...req.query, company_id: req.user.company_id, plant_id: req.plantScopeId })) }));
exports.createLog      = wrap(async (req, res) => res.status(201).json({ success: true, data: await service.createLog({ ...req.body, company_id: req.user.company_id, plant_id: req.plantScopeId, logged_by: req.user.id }) }));
exports.getUpcoming    = wrap(async (req, res) => res.json({ success: true, data: await service.getUpcoming(req.user.company_id, req.query.days, req.plantScopeId) }));
exports.getMTTR        = wrap(async (req, res) => res.json({ success: true, data: await service.getMTTR({ ...req.query, company_id: req.user.company_id, plant_id: req.plantScopeId }) }));
