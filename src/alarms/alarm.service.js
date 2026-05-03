const db = require('../db');
const { sendBulkEmails } = require('../utils/nodemailer');

exports.createAlarm = async ({ company_id, machine_id, alarm_type, severity, message }) => {
  // Check if there's already an open alarm for this machine+type
  const existing = await db.query(
    `SELECT id FROM machine_alarms
     WHERE machine_id = $1 AND alarm_type = $2 AND is_resolved = false`,
    [machine_id, alarm_type]
  );
  if (existing.rowCount > 0) return existing.rows[0]; // don't duplicate

  const result = await db.query(
    `INSERT INTO machine_alarms (company_id, machine_id, alarm_type, severity, message)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [company_id, machine_id, alarm_type, severity || 'HIGH', message]
  );
  const alarm = result.rows[0];

  // Send email notifications asynchronously
  exports.sendAlarmEmails(company_id, machine_id, alarm_type, message).catch(err =>
    console.error('Alarm email failed:', err.message)
  );

  // Create in-app notifications for all company admins
  exports.createAlarmNotification(company_id, machine_id, alarm_type, message).catch(err =>
    console.error('Alarm notification failed:', err.message)
  );

  return alarm;
};

exports.sendAlarmEmails = async (company_id, machine_id, alarm_type, message) => {
  try {
    // Get alert preferences
    const prefRes = await db.query(
      `SELECT * FROM alert_preferences WHERE company_id = $1`, [company_id]
    );
    const prefs = prefRes.rows[0];
    if (prefs && !prefs.email_enabled) return;
    if (prefs && alarm_type === 'ALARM' && !prefs.notify_on_alarm) return;
    if (prefs && alarm_type === 'OFFLINE' && !prefs.notify_on_offline) return;

    // Get machine info
    const machineRes = await db.query(
      `SELECT machine_serial_no FROM machines WHERE id = $1`, [machine_id]
    );
    const machineName = machineRes.rows[0]?.machine_serial_no || `Machine #${machine_id}`;

    // Get company admin emails
    const emailRes = await db.query(
      `SELECT DISTINCT u.email FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.company_id = $1 AND u.is_active = true
         AND r.role_name IN ('COMPANY_ADMIN','ADMIN')`,
      [company_id]
    );
    const emails = emailRes.rows.map(r => r.email).filter(Boolean);
    if (!emails.length) return;

    const subject = `[ALERT] ${alarm_type} — ${machineName}`;
    const html = `
      <h2 style="color:#dc2626">Machine Alert: ${alarm_type}</h2>
      <p><strong>Machine:</strong> ${machineName}</p>
      <p><strong>Severity:</strong> ${alarm_type === 'OFFLINE' ? 'Machine Offline' : 'Alarm Active'}</p>
      <p><strong>Message:</strong> ${message || 'No details provided'}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
      <hr/>
      <p style="color:#666;font-size:12px">This is an automated alert from your IoT monitoring platform.</p>
    `;
    await sendBulkEmails({ recipients: emails, subject, html });
  } catch (err) {
    console.error('sendAlarmEmails error:', err.message);
  }
};

exports.createAlarmNotification = async (company_id, machine_id, alarm_type, message) => {
  try {
    const machineRes = await db.query(
      `SELECT machine_serial_no FROM machines WHERE id = $1`, [machine_id]
    );
    const machineName = machineRes.rows[0]?.machine_serial_no || `Machine #${machine_id}`;

    // Get all active users in this company
    const usersRes = await db.query(
      `SELECT id FROM users WHERE company_id = $1 AND is_active = true`, [company_id]
    );
    if (!usersRes.rowCount) return;

    const values = usersRes.rows.map(u =>
      `(${company_id}, ${u.id}, '${alarm_type === 'ALARM' ? 'ALARM' : 'WARNING'}',
        '${alarm_type} — ${machineName}',
        '${message || ''}', '/dashboard')`
    ).join(',');

    await db.query(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link)
       VALUES ${values}`
    );
  } catch (err) {
    console.error('createAlarmNotification error:', err.message);
  }
};

exports.resolveAlarm = async ({ alarm_id, resolved_by, resolution_note, company_id }) => {
  const result = await db.query(
    `UPDATE machine_alarms
     SET is_resolved = true, resolved_by = $1, resolved_at = NOW(), resolution_note = $2
     WHERE id = $3 AND company_id = $4
     RETURNING *`,
    [resolved_by, resolution_note || null, alarm_id, company_id]
  );
  if (!result.rowCount) throw { status: 404, message: 'Alarm not found' };
  return result.rows[0];
};

exports.getAlarms = async ({ company_id, is_snt_super, machine_id, is_resolved, page = 1, limit = 20 }) => {
  const conditions = [];
  const params = [];
  let i = 1;

  if (!is_snt_super) { conditions.push(`a.company_id = $${i++}`); params.push(company_id); }
  if (machine_id)    { conditions.push(`a.machine_id = $${i++}`); params.push(machine_id); }
  if (is_resolved !== undefined && is_resolved !== '') {
    conditions.push(`a.is_resolved = $${i++}`);
    params.push(is_resolved === 'true' || is_resolved === true);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const countRes = await db.query(`SELECT COUNT(*) FROM machine_alarms a ${where}`, params);
  const total = parseInt(countRes.rows[0].count);

  const dataRes = await db.query(
    `SELECT a.*, m.machine_serial_no, u.username as resolved_by_name
     FROM machine_alarms a
     JOIN machines m ON m.id = a.machine_id
     LEFT JOIN users u ON u.id = a.resolved_by
     ${where}
     ORDER BY a.started_at DESC
     LIMIT $${i++} OFFSET $${i++}`,
    [...params, limitNum, offset]
  );

  return { data: dataRes.rows, pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) } };
};

exports.getAlertPreferences = async (company_id) => {
  const res = await db.query(
    `SELECT * FROM alert_preferences WHERE company_id = $1`, [company_id]
  );
  return res.rows[0] || { company_id, email_enabled: true, notify_on_alarm: true, notify_on_offline: true };
};

exports.updateAlertPreferences = async (company_id, prefs) => {
  const res = await db.query(
    `INSERT INTO alert_preferences (company_id, email_enabled, notify_on_alarm, notify_on_offline, notify_on_low_oee, low_oee_threshold, offline_threshold_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id)
     DO UPDATE SET
       email_enabled = EXCLUDED.email_enabled,
       notify_on_alarm = EXCLUDED.notify_on_alarm,
       notify_on_offline = EXCLUDED.notify_on_offline,
       notify_on_low_oee = EXCLUDED.notify_on_low_oee,
       low_oee_threshold = EXCLUDED.low_oee_threshold,
       offline_threshold_seconds = EXCLUDED.offline_threshold_seconds,
       updated_at = NOW()
     RETURNING *`,
    [company_id,
     prefs.email_enabled ?? true,
     prefs.notify_on_alarm ?? true,
     prefs.notify_on_offline ?? true,
     prefs.notify_on_low_oee ?? false,
     prefs.low_oee_threshold ?? 50,
     prefs.offline_threshold_seconds ?? 120]
  );
  return res.rows[0];
};
