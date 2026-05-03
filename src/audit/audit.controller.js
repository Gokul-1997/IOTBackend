const service = require('./audit.service');

exports.getLogs = async (req, res) => {
  try {
    const result = await service.getLogs({
      company_id:   req.user.company_id,
      is_snt_super: req.user.is_snt_super,
      ...req.query
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
