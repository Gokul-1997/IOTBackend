const service = require('./downtime.service');

exports.getReasons = async (req, res) => {
  try {
    const data = await service.getReasons(req.user.company_id);
    res.json({ success: true, data });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.createReason = async (req, res) => {
  try {
    const data = await service.createReason({ ...req.body, company_id: req.user.company_id });
    res.status(201).json({ success: true, data });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.updateReason = async (req, res) => {
  try {
    const data = await service.updateReason(req.params.id, req.user.company_id, req.body);
    res.json({ success: true, data });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.logEvent = async (req, res) => {
  try {
    const data = await service.logEvent({ ...req.body, company_id: req.user.company_id, entered_by: req.user.id });
    res.status(201).json({ success: true, data });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.getEvents = async (req, res) => {
  try {
    const result = await service.getEvents({ ...req.query, company_id: req.user.company_id });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getDowntimeSummary = async (req, res) => {
  try {
    const data = await service.getDowntimeSummary({ ...req.query, company_id: req.user.company_id });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
