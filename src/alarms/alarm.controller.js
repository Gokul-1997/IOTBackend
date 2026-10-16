const service = require('./alarm.service');
const notificationRules = require('./alarm-notification.service');

const configuration = (method, args) => async (req, res) => {
  try { res.json({ success: true, data: await notificationRules[method](req.user, ...args(req)) }); }
  catch (error) { res.status(error.status || 500).json({ success: false, message: error.message }); }
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
    res.status(e.status || 500).json({ success: false, message: e.message });
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
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
};

exports.getPreferences = async (req, res) => {
  try {
    const prefs = await service.getAlertPreferences(req.user.company_id);
    res.json({ success: true, data: prefs });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const prefs = await service.updateAlertPreferences(req.user.company_id, req.body);
    res.json({ success: true, data: prefs });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
