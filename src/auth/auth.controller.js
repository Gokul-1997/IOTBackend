const service = require('./auth.service');

exports.login = async (req, res) => {
  try {
    const result = await service.login(req.body, req);
    return res.json(result);
  } catch (e) {
    return res.status(e.status || 401).json({
      message: e.message || 'Login failed'
    });
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email required' });
    }

    // 🔁 SAME FLOW – do not reveal user existence
    await service.sendResetLink(email);

    return res.json({
      success: true,
      message: 'If the account exists, a reset link has been sent'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Unable to process request'
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    await service.resetPassword(token, password);

    return res.json({
      success: true,
      message: 'Password reset successful'
    });

  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Invalid or expired token'
    });
  }
};