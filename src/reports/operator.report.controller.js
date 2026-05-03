const service = require('./operator.report.service');

exports.getOperatorPerformance = async (req, res) => {
  try {
    const result = await service.getOperatorPerformance({ company_id: req.user.company_id, ...req.query });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
