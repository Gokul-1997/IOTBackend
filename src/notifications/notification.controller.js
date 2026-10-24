const sendError = require('../utils/controller-error');
const service = require('./notification.service');

exports.getNotifications = async (req, res) => {
  try {
    const result = await service.getNotifications({ ...req.query, user_id: req.user.id, company_id: req.user.company_id });
    res.json({ success: true, ...result });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.markRead = async (req, res) => {
  try {
    await service.markRead({ user_id: req.user.id, notification_id: req.params.id, company_id: req.user.company_id });
    // the person's other tabs and devices show the new count at once
    service.announceUnread([req.user.id]);
    res.json({ success: true });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    await service.markAllRead(req.user.id, req.user.company_id);
    service.announceUnread([req.user.id]);
    res.json({ success: true });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const count = await service.getUnreadCount(req.user.id, req.user.company_id);
    res.json({ success: true, count });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.getPreferences = async (req, res) => {
  try {
    const prefs = await service.getPreferences(req.user.id);
    res.json({ success: true, data: prefs });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const prefs = await service.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, data: prefs });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};
