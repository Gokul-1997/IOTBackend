const service = require('./maintenance.service');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.getSchedules   = wrap(async (req, res) => res.json({ success: true, ...(await service.getSchedules({ company_id: req.user.company_id, ...req.query })) }));
exports.createSchedule = wrap(async (req, res) => res.status(201).json({ success: true, data: await service.createSchedule({ company_id: req.user.company_id, created_by: req.user.id, ...req.body }) }));
exports.updateSchedule = wrap(async (req, res) => res.json({ success: true, data: await service.updateSchedule(req.params.id, req.user.company_id, req.body) }));
exports.deleteSchedule = wrap(async (req, res) => { await service.deleteSchedule(req.params.id, req.user.company_id); res.json({ success: true }); });
exports.getLogs        = wrap(async (req, res) => res.json({ success: true, ...(await service.getLogs({ company_id: req.user.company_id, ...req.query })) }));
exports.createLog      = wrap(async (req, res) => res.status(201).json({ success: true, data: await service.createLog({ company_id: req.user.company_id, logged_by: req.user.id, ...req.body }) }));
exports.getUpcoming    = wrap(async (req, res) => res.json({ success: true, data: await service.getUpcoming(req.user.company_id, req.query.days) }));
exports.getMTTR        = wrap(async (req, res) => res.json({ success: true, data: await service.getMTTR({ company_id: req.user.company_id, ...req.query }) }));
