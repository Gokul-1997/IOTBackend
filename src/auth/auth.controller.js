const service = require('./auth.service');

exports.login = async (req, res) => {
  try {
    const result = await service.login(req.body, req);
    res.json(result);
  } catch (e) {
    res.status(e.status || 401).json({
      success: false,
      message: e.message || 'Login failed'
    });
  }
};

exports.refresh = async (req, res) => {
  try {
    const refreshToken =
      req.body?.refreshToken ||
      req.headers['x-refresh-token'];

    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token required' });
    }

    const result = await service.refresh(refreshToken, req);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 401).json({
      success: false,
      message: e.message || 'Unable to refresh token'
    });
  }
};

exports.logout = async (req, res) => {
  try {
    const refreshToken =
      req.body?.refreshToken ||
      req.headers['x-refresh-token'];

    if (refreshToken) {
      await service.logout(refreshToken);
    }

    res.json({ success: true });
  } catch {
    res.json({ success: true }); // safe logout
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email required' });
    }

    await service.sendResetLink(email);

    res.json({
      success: true,
      message: 'If the account exists, a reset link has been sent'
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      message: 'Unable to process request'
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Invalid token or password'
      });
    }

    await service.resetPassword(token, password);

    res.json({
      success: true,
      message: 'Password reset successful'
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      message: e.message || 'Invalid or expired token'
    });
  }
};
