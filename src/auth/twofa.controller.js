const service = require('./twofa.service');

exports.setup = async (req, res) => {
  try {
    const result = await service.setup2FA(req.user.id, req.user.email || req.body.email);
    res.json({ success: true, data: result });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};

exports.enable = async (req, res) => {
  try {
    const result = await service.enable2FA(req.user.id, req.body.token);
    res.json({ success: true, data: result, message: 'Save these backup codes securely.' });
  } catch (e) { res.status(e.status || 400).json({ success: false, message: e.message }); }
};

exports.disable = async (req, res) => {
  try {
    await service.disable2FA(req.user.id);
    res.json({ success: true, message: '2FA disabled' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.getStatus = async (req, res) => {
  try {
    const status = await service.get2FAStatus(req.user.id);
    res.json({ success: true, data: status });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};

exports.verify = async (req, res) => {
  try {
    const valid = await service.verify2FA(req.user.id, req.body.token);
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid code' });
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
};
