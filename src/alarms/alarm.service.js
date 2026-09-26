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

    // Get company admin emails — none while S&T has the company turned off
    const emailRes = await db.query(
      `SELECT DISTINCT u.email FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       JOIN companies c ON c.id = u.company_id AND c.is_active = true
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

    /* Who is told, and where their alert takes them.

       Only people whose role can see alarms — the company admin, or a role
       holding the Alarms page, the Alarm Report or the Live Dashboard — and
       who have not switched Alarms off in Settings. Everyone in the company
       used to get every alarm, HR and Setter included, with a link to the
       Live Dashboard most of them could not open. Each alert now links to
       the first alarm page its recipient can open. */
    const usersRes = await db.query(
      `SELECT u.id,
              CASE
                WHEN bool_or(r.role_name = 'COMPANY_ADMIN' AND r.company_id IS NULL)
                  OR bool_or(p.permission_key = 'page:alarms:view')           THEN '/alarms'
                WHEN bool_or(p.permission_key = 'page:analytics-alarms:view') THEN '/alarm-report'
                ELSE '/dashboard'
              END AS link
         FROM users u
         JOIN companies c ON c.id = u.company_id AND c.is_active = true
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
         LEFT JOIN notification_preferences np ON np.user_id = u.id
        WHERE u.company_id = $1 AND u.is_active = true
          AND COALESCE(np.notify_alarm, true)
        GROUP BY u.id
       HAVING bool_or(r.role_name = 'COMPANY_ADMIN' AND r.company_id IS NULL)
           OR bool_or(p.permission_key IN ('page:alarms:view', 'page:analytics-alarms:view', 'page:dashboard:view'))`,
      [company_id]
    );
    if (!usersRes.rowCount) return;

    /* Parameters, not string-built SQL: the message comes from the machine
       controller, and one containing an apostrophe used to break the insert. */
    await db.query(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link)
       SELECT $1, t.user_id, $2, $3, $4, t.link
         FROM unnest($5::int[], $6::text[]) AS t(user_id, link)`,
      [company_id, alarm_type === 'ALARM' ? 'ALARM' : 'WARNING', `${alarm_type} — ${machineName}`,
       message || '', usersRes.rows.map(u => u.id), usersRes.rows.map(u => u.link)]
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

/*
 * The alarm list. Besides machine and resolved:
 *  - active=true: alarms the controller has not cleared yet (ended_at is
 *    null) — "active now". "Unresolved" alone counted every alarm nobody
 *    had clicked Resolve on, hundreds of them long cleared;
 *  - severity=CRITICAL | NORMAL (NORMAL = anything not critical, the way
 *    the Alarm Report counts it).
 * Bad input is a 400, not a 500: page=abc reached the SQL as NaN.
 */
const badRequest = message => ({ status: 400, message });
const positiveInt = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${label} must be a positive whole number`);
  return n;
};
const flag = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw badRequest(`${label} must be true or false`);
};

exports.getAlarms = async ({ company_id, is_snt_super, machine_id, is_resolved, active, severity, page = 1, limit = 20 }) => {
  const machineId = positiveInt(machine_id, 'machine_id');
  const resolved = flag(is_resolved, 'is_resolved');
  const isActive = flag(active, 'active');
  const sev = severity === undefined || severity === '' ? null : String(severity).toUpperCase();
  if (sev !== null && sev !== 'CRITICAL' && sev !== 'NORMAL') throw badRequest('severity must be CRITICAL or NORMAL');
  const pageNum = positiveInt(page, 'page') ?? 1;
  const limitNum = Math.min(100, positiveInt(limit, 'limit') ?? 20);

  const conditions = [];
  const params = [];
  let i = 1;

  if (!is_snt_super) { conditions.push(`a.company_id = $${i++}`); params.push(company_id); }
  if (machineId)     { conditions.push(`a.machine_id = $${i++}`); params.push(machineId); }
  if (resolved !== null) { conditions.push(`a.is_resolved = $${i++}`); params.push(resolved); }
  if (isActive !== null) conditions.push(isActive ? 'a.ended_at IS NULL' : 'a.ended_at IS NOT NULL');
  if (sev === 'CRITICAL') conditions.push(`UPPER(a.severity) = 'CRITICAL'`);
  if (sev === 'NORMAL')   conditions.push(`UPPER(a.severity) <> 'CRITICAL'`);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (pageNum - 1) * limitNum;

  const countRes = await db.query(`SELECT COUNT(*) FROM machine_alarms a ${where}`, params);
  const total = parseInt(countRes.rows[0].count);

  const dataRes = await db.query(
    `SELECT a.*, m.machine_serial_no, u.username as resolved_by_name
     FROM machine_alarms a
     JOIN machines m ON m.id = a.machine_id
     LEFT JOIN users u ON u.id = a.resolved_by
     ${where}
     ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC
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
