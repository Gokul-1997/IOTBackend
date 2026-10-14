const service = require('./ticket.service');

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); }
  catch (e) { next(e); }
};

exports.getTickets = wrap(async (req, res) =>
  res.json({ success: true, ...(await service.getTickets({ ...req.query, company_id: req.user.company_id, plant_id: req.plantScopeId })) }));

exports.getTicketById = wrap(async (req, res) =>
  res.json({ success: true, data: await service.getTicketById(req.params.id, req.user.company_id, req.plantScopeId) }));

exports.createTicket = wrap(async (req, res) =>
  res.status(201).json({ success: true, data: await service.createTicket({ ...req.body, company_id: req.user.company_id, plant_id: req.plantScopeId, created_by: req.user.id }) }));

exports.updateTicket = wrap(async (req, res) =>
  res.json({ success: true, data: await service.updateTicket(req.params.id, req.user.company_id, req.body, req.plantScopeId) }));

exports.updateStatus = wrap(async (req, res) =>
  res.json({ success: true, data: await service.updateTicketStatus(req.params.id, req.user.company_id, { ...req.body, changed_by: req.user.id, plant_id: req.plantScopeId }) }));

exports.assignTicket = wrap(async (req, res) =>
  res.json({ success: true, data: await service.assignTicket(req.params.id, req.user.company_id, { ...req.body, changed_by: req.user.id, plant_id: req.plantScopeId }) }));

exports.getSummary = wrap(async (req, res) =>
  res.json({ success: true, data: await service.getSummary(req.user.company_id, req.plantScopeId) }));

exports.getAssignees = wrap(async (req, res) =>
  res.json({ success: true, data: await service.getAssignees(req.user.company_id, req.plantScopeId) }));
