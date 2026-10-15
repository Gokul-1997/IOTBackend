const db = require('../db');
const notifications = require('../notifications/notification.service');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function positive(value, label, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    fail(400, `${label} must be a positive whole number`);
  }
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    fail(400, `${label} must be a positive whole number`);
  }
  return Number(value);
}
function companyAdmin(actor = {}) {
  if (actor.is_snt_super || !actor.company_id ||
      !(actor.roles || []).some(role => role === 'COMPANY_ADMIN' || role === 'ADMIN')) {
    fail(403, 'Alarm notification rules are managed by your company administrator');
  }
  return positive(actor.company_id, 'Company');
}

const RULE_COLUMNS = `m.id AS machine_id, m.machine_serial_no, p.plant_name,
  COALESCE(r.enabled, FALSE) AS enabled, COALESCE(r.delay_seconds, 600) AS delay_seconds`;

/** Every active machine appears, including machines which have never opted in. */
exports.getRules = async (actor, query = {}) => {
  const companyId = companyAdmin(actor);
  const page = positive(query.page, 'page', 1);
  const limit = Math.min(50, positive(query.limit, 'limit', 20));
  if (!Number.isSafeInteger((page - 1) * limit)) fail(400, 'page is too large');
  if (query.search !== undefined && typeof query.search !== 'string') fail(400, 'search must be text');
  const search = (query.search || '').trim();
  if (search.length > 100) fail(400, 'search must be at most 100 characters');
  const params = [companyId, search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null];
  const where = `WHERE m.company_id = $1 AND m.is_active = TRUE
    AND ($2::text IS NULL OR m.machine_serial_no ILIKE $2 ESCAPE '\\' OR p.plant_name ILIKE $2 ESCAPE '\\')`;
  const joins = `FROM machines m LEFT JOIN plants p ON p.id = m.plant_id AND p.company_id = m.company_id
    LEFT JOIN alarm_notification_rules r ON r.machine_id = m.id AND r.company_id = m.company_id`;
  const [count, rows] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total ${joins} ${where}`, params),
    db.query(`SELECT ${RULE_COLUMNS} ${joins} ${where}
      ORDER BY m.machine_serial_no, m.id LIMIT $3 OFFSET $4`, [...params, limit, (page - 1) * limit])
  ]);
  const total = Number(count.rows[0]?.total || 0);
  return { data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

exports.updateRule = async (actor, machineId, body = {}) => {
  const companyId = companyAdmin(actor);
  const id = positive(machineId, 'machine_id');
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
    fail(400, 'enabled must be true or false');
  }
  if (typeof body.delay_seconds !== 'number' || !Number.isInteger(body.delay_seconds) ||
      body.delay_seconds < 1 || body.delay_seconds > 86400) {
    fail(400, 'delay_seconds must be a whole number between 1 and 86400');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const machine = await client.query(`SELECT m.id, m.machine_serial_no, p.plant_name
      FROM machines m LEFT JOIN plants p ON p.id = m.plant_id AND p.company_id = m.company_id
      WHERE m.id = $1 AND m.company_id = $2 AND m.is_active = TRUE FOR SHARE OF m`, [id, companyId]);
    if (!machine.rows.length) fail(404, 'Machine not found');
    const { rows } = await client.query(`INSERT INTO alarm_notification_rules
      (company_id, machine_id, enabled, delay_seconds, updated_by)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (company_id, machine_id) DO UPDATE SET
        enabled = EXCLUDED.enabled, delay_seconds = EXCLUDED.delay_seconds,
        enabled_since = CASE
          WHEN alarm_notification_rules.enabled IS DISTINCT FROM EXCLUDED.enabled
            OR alarm_notification_rules.delay_seconds IS DISTINCT FROM EXCLUDED.delay_seconds
          THEN NOW() ELSE alarm_notification_rules.enabled_since END,
        updated_by = EXCLUDED.updated_by, updated_at = NOW()
      RETURNING enabled, delay_seconds`, [companyId, id, body.enabled, body.delay_seconds, actor.id]);
    await client.query('COMMIT');
    return { machine_id: machine.rows[0].id, machine_serial_no: machine.rows[0].machine_serial_no,
      plant_name: machine.rows[0].plant_name, ...rows[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
};

/* A current role and a current company grant must agree on the same page.
   A company with no grant rows is unrestricted, matching access.middleware.
   Admin means the reserved system role, never a similarly named owned role. */
const RECIPIENT_SQL = `WITH pages(permission_key, link, rank) AS (VALUES
    ('page:alarms:view', '/alarms', 1),
    ('page:analytics-alarms:view', '/alarm-report', 2),
    ('page:dashboard:view', '/dashboard', 3)
  ), allowed AS (
    SELECT u.id, pages.link, pages.rank
    FROM users u
    JOIN companies c ON c.id = u.company_id AND c.is_active = TRUE
    CROSS JOIN pages
    JOIN permissions p ON p.permission_key = pages.permission_key
    LEFT JOIN notification_preferences np ON np.user_id = u.id
    WHERE u.company_id = $1 AND u.is_active = TRUE AND COALESCE(np.notify_alarm, TRUE)
      AND (NOT EXISTS (SELECT 1 FROM company_permissions cp WHERE cp.company_id = u.company_id)
        OR EXISTS (SELECT 1 FROM company_permissions cp WHERE cp.company_id = u.company_id AND cp.permission_id = p.id))
      AND (EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id AND r.company_id IS NULL AND r.role_name IN ('COMPANY_ADMIN', 'ADMIN'))
        OR (u.plant_id IS NULL OR u.plant_id = $2))
      AND (EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id AND r.company_id IS NULL AND r.role_name IN ('COMPANY_ADMIN', 'ADMIN'))
        OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          JOIN role_permissions rp ON rp.role_id = r.id
          WHERE ur.user_id = u.id AND (r.company_id IS NULL OR r.company_id = u.company_id)
            AND rp.permission_id = p.id))
  ) SELECT DISTINCT ON (id) id, link FROM allowed ORDER BY id, rank`;

/**
 * A durable inbox, independent of open browsers or the MQTT process. Each
 * occurrence is delivered once after fresh accepted observations confirm the
 * configured duration. Missing observations restart the qualification window.
 */
exports.processDueAlarms = async ({ batchSize = 100 } = {}) => {
  const limit = Math.min(500, positive(batchSize, 'batchSize', 100));
  const client = await db.connect();
  const recipients = new Set();
  let delivered = 0;
  let checked = 0;
  try {
    await client.query('BEGIN');
    const { rows: alarms } = await client.query(`SELECT a.id, a.company_id, a.machine_id,
        a.alarm_type, a.alarm_code, a.message, m.machine_serial_no, m.plant_id, r.delay_seconds
      FROM machine_alarms a
      JOIN alarm_notification_rules r ON r.company_id = a.company_id AND r.machine_id = a.machine_id AND r.enabled = TRUE
      JOIN machines m ON m.id = a.machine_id AND m.company_id = a.company_id AND m.is_active = TRUE
      JOIN companies c ON c.id = a.company_id AND c.is_active = TRUE
      JOIN LATERAL (
        SELECT t.alarm, t.device_time, t.received_at FROM telemetry_raw t
        WHERE t.company_id = a.company_id AND t.machine_id = a.machine_id
          AND t.received_at >= NOW() - INTERVAL '120 seconds'
        ORDER BY t.received_at DESC, t.device_time DESC LIMIT 1
      ) observed ON observed.alarm = TRUE
        AND observed.received_at <= NOW()
        AND observed.device_time >= EXTRACT(EPOCH FROM NOW() - INTERVAL '120 seconds')
        AND observed.device_time <= EXTRACT(EPOCH FROM NOW())
      LEFT JOIN LATERAL (
        SELECT g.resumed_at FROM ingest_gaps g
        WHERE g.company_id = a.company_id AND g.machine_id = a.machine_id AND g.resumed_at >= a.started_at
        ORDER BY g.resumed_at DESC LIMIT 1
      ) gap ON TRUE
      WHERE a.ended_at IS NULL AND a.notification_sent_at IS NULL
        AND (m.plant_id IS NULL OR EXISTS (SELECT 1 FROM plants plant
          WHERE plant.id = m.plant_id AND plant.company_id = m.company_id AND plant.is_active = TRUE))
        AND to_timestamp(observed.device_time) >=
          GREATEST(a.started_at, r.enabled_since, gap.resumed_at, a.notification_continuity_started_at)
            + make_interval(secs => r.delay_seconds)
      ORDER BY a.notification_checked_at NULLS FIRST, a.started_at, a.id
      LIMIT $1 FOR UPDATE OF a SKIP LOCKED FOR SHARE OF r, m, c SKIP LOCKED`, [limit]);
    for (const alarm of alarms) {
      checked++;
      // A failed/no-recipient occurrence moves behind unchecked occurrences,
      // so an inaccessible old alarm cannot starve other machines' alerts.
      await client.query('UPDATE machine_alarms SET notification_checked_at = NOW() WHERE id = $1', [alarm.id]);
      const { rows: users } = await client.query(RECIPIENT_SQL, [alarm.company_id, alarm.plant_id]);
      if (!users.length) continue;
      const duration = alarm.delay_seconds < 60 ? `${alarm.delay_seconds} seconds`
        : alarm.delay_seconds % 60 === 0 ? `${alarm.delay_seconds / 60} minutes` : `${alarm.delay_seconds} seconds`;
      const title = `Alarm active — ${alarm.machine_serial_no}`.slice(0, 200);
      const message = `${alarm.alarm_code || alarm.alarm_type}: ${alarm.message || 'Controller alarm'}. Still active after ${duration}.`;
      const inserted = await client.query(`INSERT INTO notifications (company_id, user_id, type, title, message, link, alarm_id)
        SELECT $1, recipient.user_id, 'ALARM', $2, $3, recipient.link, $4
        FROM unnest($5::int[], $6::text[]) AS recipient(user_id, link)
        ON CONFLICT (alarm_id, user_id) WHERE alarm_id IS NOT NULL DO NOTHING RETURNING user_id`,
      [alarm.company_id, title, message, alarm.id, users.map(user => user.id), users.map(user => user.link)]);
      await client.query('UPDATE machine_alarms SET notification_sent_at = NOW() WHERE id = $1', [alarm.id]);
      delivered++;
      for (const user of inserted.rows) recipients.add(user.user_id);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  // Socket delivery is advisory. Its failure cannot undo committed inbox rows.
  if (recipients.size) {
    try { await notifications.announceUnread([...recipients]); }
    catch (error) { console.error('Alarm unread announcement failed:', error.message); }
  }
  return { checked, delivered, recipients: recipients.size };
};
