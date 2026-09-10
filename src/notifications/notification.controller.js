const service = require('./notification.service');

exports.getNotifications = async (req, res) => {
  try {
    const result = await service.getNotifications({ ...req.query, user_id: req.user.id, company_id: req.user.company_id });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.markRead = async (req, res) => {
  try {
    await service.markRead({ user_id: req.user.id, notification_id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await service.markAllRead(req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const count = await service.getUnreadCount(req.user.id);
    res.json({ success: true, count });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
