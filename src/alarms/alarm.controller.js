const sendError = require('../utils/controller-error');
const service = require('./alarm.service');
const notificationRules = require('./alarm-notification.service');

const configuration = (method, args) => async (req, res) => {
  try { res.json({ success: true, data: await notificationRules[method](req.user, ...args(req)) }); }
  catch (error) { return sendError(error, req, res, { success: false }); }
};
exports.getNotificationPolicy = configuration('getPolicy', () => []);
exports.updateNotificationPolicy = configuration('updatePolicy', req => [req.body]);
// Keep a clear response for old deployed clients rather than silently saving
// delay rules which no longer control this critical-only phase.
exports.retiredNotificationRules = (_req, res) => {
  res.status(410).json({ success: false, message: 'Machine delay rules are not available in this phase. Use company critical alert settings.' });
};

exports.getAlarms = async (req, res) => {
  try {
    const result = await service.getAlarms({
      ...req.query,
      // identity last: a client that sends is_snt_super=true would
      // otherwise switch off the company filter entirely
      company_id: req.user.company_id,
      is_snt_super: req.user.is_snt_super
    });
    res.json({ success: true, ...result });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.resolveAlarm = async (req, res) => {
  try {
    const alarm = await service.resolveAlarm({
      alarm_id: req.params.id,
      resolved_by: req.user.id,
      resolution_note: req.body.resolution_note,
      company_id: req.user.company_id
    });
    res.json({ success: true, data: alarm });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.getPreferences = async (req, res) => {
  try {
    const prefs = await service.getAlertPreferences(req.user.company_id);
    res.json({ success: true, data: prefs });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const prefs = await service.updateAlertPreferences(req.user.company_id, req.body);
    res.json({ success: true, data: prefs });
  } catch (e) {
    return sendError(e, req, res, { success: false });
  }
};
