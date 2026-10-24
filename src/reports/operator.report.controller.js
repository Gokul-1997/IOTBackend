const sendError = require('../utils/controller-error');
const service = require('./operator.report.service');

exports.getOperatorPerformance = async (req, res) => {
  try {
    const result = await service.getOperatorPerformance({ ...req.query, company_id: req.user.company_id });
    res.json({ success: true, ...result });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};
