const service = require('./downtime.service');

/*
 * Errors go to the error middleware (Express 5 forwards a rejected handler):
 * a 4xx thrown on purpose keeps its message; anything else — a database
 * error — reaches the caller as a plain message and a reference, never as
 * the database's own words.
 */

exports.getReasons = async (req, res) => {
  const data = await service.getReasons(req.user.company_id);
  res.json({ success: true, data });
};

exports.createReason = async (req, res) => {
  const data = await service.createReason({ ...req.body, company_id: req.user.company_id });
  res.status(201).json({ success: true, data });
};

exports.updateReason = async (req, res) => {
  const data = await service.updateReason(req.params.id, req.user.company_id, req.body);
  res.json({ success: true, data });
};

exports.logEvent = async (req, res) => {
  const data = await service.logEvent({ ...req.body, company_id: req.user.company_id, entered_by: req.user.id });
  res.status(201).json({ success: true, data });
};

exports.getEvents = async (req, res) => {
  const result = await service.getEvents({ ...req.query, company_id: req.user.company_id });
  res.json({ success: true, ...result });
};

exports.getDowntimeSummary = async (req, res) => {
  const data = await service.getDowntimeSummary({ ...req.query, company_id: req.user.company_id });
  res.json({ success: true, data });
};
