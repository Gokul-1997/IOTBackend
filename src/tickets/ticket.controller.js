const service = require('./ticket.service');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.getTickets = wrap(async (req, res) =>
  res.json({ success: true, ...(await service.getTickets({ ...req.query, company_id: req.user.company_id })) }));

exports.getTicketById = wrap(async (req, res) =>
  res.json({ success: true, data: await service.getTicketById(req.params.id, req.user.company_id) }));

exports.createTicket = wrap(async (req, res) =>
  res.status(201).json({ success: true, data: await service.createTicket({ ...req.body, company_id: req.user.company_id, created_by: req.user.id }) }));

exports.updateTicket = wrap(async (req, res) =>
  res.json({ success: true, data: await service.updateTicket(req.params.id, req.user.company_id, req.body) }));

exports.updateStatus = wrap(async (req, res) =>
  res.json({ success: true, data: await service.updateTicketStatus(req.params.id, req.user.company_id, { ...req.body, changed_by: req.user.id }) }));

exports.assignTicket = wrap(async (req, res) =>
  res.json({ success: true, data: await service.assignTicket(req.params.id, req.user.company_id, { ...req.body, changed_by: req.user.id }) }));

exports.getSummary = wrap(async (req, res) =>
  res.json({ success: true, data: await service.getSummary(req.user.company_id) }));
