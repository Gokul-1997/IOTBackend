const db = require('../db');
const notifications = require('../notifications/notification.service');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function positive(value, label, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    fail(400, `${label} must be a positive whole number`);
  }
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail(400, `${label} must be a positive whole number`);
  return Number(value);
}
function companyAdmin(actor = {}) {
  if (actor.is_snt_super || !actor.company_id || !(actor.roles || []).some(role => role === 'COMPANY_ADMIN' || role === 'ADMIN')) {
    fail(403, 'Critical alarm notifications are managed by your company administrator');
  }
  return positive(actor.company_id, 'Company');
}
async function transaction(work) {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
exports.getPolicy = async actor => {
  const companyId = companyAdmin(actor);
  const [{ rows }, { rows: counts }] = await Promise.all([
    db.query('SELECT enabled,version,updated_at FROM alarm_notification_policies WHERE company_id=$1', [companyId]),
    db.query('SELECT COUNT(*)::int AS machines FROM machines WHERE company_id=$1 AND is_active=TRUE', [companyId])
  ]);
  return { enabled: rows[0]?.enabled || false, configured: !!rows.length,
    version: rows[0]?.version || 0, updated_at: rows[0]?.updated_at || null, counts: counts[0] || { machines: 0 } };
};
exports.updatePolicy = async (actor, body = {}) => {
  const companyId = companyAdmin(actor);
  if (typeof body?.enabled !== 'boolean') fail(400, 'enabled must be true or false');
  if (typeof body.expected_version !== 'number' || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0) {
    fail(400, 'expected_version must be a non-negative whole number');
  }
  await transaction(async client => {
    // The company lock also protects dispatch while this configuration changes.
    await client.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE', [companyId]);
    const { rows } = await client.query('SELECT version FROM alarm_notification_policies WHERE company_id=$1 FOR UPDATE', [companyId]);
    if ((rows[0]?.version || 0) !== body.expected_version) fail(409, 'This setting changed in another session. Reload before saving.');
    await client.query(`INSERT INTO alarm_notification_policies(company_id,enabled,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(company_id) DO UPDATE SET enabled=EXCLUDED.enabled,
      version=CASE WHEN alarm_notification_policies.enabled IS DISTINCT FROM EXCLUDED.enabled THEN alarm_notification_policies.version+1 ELSE alarm_notification_policies.version END,
      enabled_since=CASE WHEN alarm_notification_policies.enabled IS DISTINCT FROM EXCLUDED.enabled THEN NOW() ELSE alarm_notification_policies.enabled_since END,
      updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [companyId, body.enabled, actor.id]);
  });
  return exports.getPolicy(actor);
};

const RECIPIENT_SQL = `WITH pages(permission_key, link, rank) AS (VALUES
    ('page:alarms:view', '/alarms', 1),('page:analytics-alarms:view', '/alarm-report', 2),('page:dashboard:view', '/dashboard', 3)
  ), allowed AS (
    SELECT u.id,pages.link,pages.rank FROM users u
    JOIN companies c ON c.id=u.company_id AND c.is_active=TRUE CROSS JOIN pages
    JOIN permissions p ON p.permission_key=pages.permission_key
    LEFT JOIN notification_preferences np ON np.user_id=u.id
    WHERE u.company_id=$1 AND u.is_active=TRUE AND COALESCE(np.notify_alarm,TRUE)
      AND (NOT EXISTS(SELECT 1 FROM company_permissions cp WHERE cp.company_id=u.company_id)
        OR EXISTS(SELECT 1 FROM company_permissions cp WHERE cp.company_id=u.company_id AND cp.permission_id=p.id))
      AND (EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.company_id IS NULL AND r.role_name IN('COMPANY_ADMIN','ADMIN'))
        OR (u.plant_id IS NULL OR u.plant_id=$2))
      AND (EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.company_id IS NULL AND r.role_name IN('COMPANY_ADMIN','ADMIN'))
        OR EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id
          WHERE ur.user_id=u.id AND (r.company_id IS NULL OR r.company_id=u.company_id) AND rp.permission_id=p.id))
  ) SELECT DISTINCT ON(id) id,link FROM allowed ORDER BY id,rank`;
const ACTIVE = `m.is_active=TRUE AND c.is_active=TRUE AND (m.plant_id IS NULL OR EXISTS(
  SELECT 1 FROM plants plant WHERE plant.id=m.plant_id AND plant.company_id=m.company_id AND plant.is_active=TRUE))`;

/** Durably dispatch a bounded amount of accepted events and due active alarms. */
exports.processDueAlarms = async ({ batchSize = 100 } = {}) => {
  const limit = Math.min(500, positive(batchSize, 'batchSize', 100));
  const recipients = new Set();
  let checked = 0, delivered = 0, progressed = 0;
  await transaction(async client => {
    const dispatched = new Set();
    async function deliver(alarm) {
      const key = `${alarm.alarm_id || alarm.id}:${alarm.severity_class}`;
      if (dispatched.has(key) || alarm.notification_delivered_priorities?.includes(alarm.severity_class)) return true;
      const { rows: users } = await client.query(RECIPIENT_SQL, [alarm.company_id, alarm.plant_id]);
      if (!users.length) return false;
      const title = `Critical alarm — ${alarm.machine_serial_no}`.slice(0,200);
      const message = `${alarm.alarm_code || alarm.alarm_type || 'Controller alarm'}: ${alarm.message || 'Controller alarm'}.`;
      const inserted = await client.query(`INSERT INTO notifications(company_id,user_id,type,title,message,link,alarm_id,alarm_priority)
        SELECT $1,recipient.user_id,'ALARM',$2,$3,recipient.link,$4,$5
        FROM unnest($6::int[],$7::text[]) AS recipient(user_id,link)
        ON CONFLICT(alarm_id,user_id,alarm_priority) WHERE alarm_id IS NOT NULL DO NOTHING RETURNING user_id`,
      [alarm.company_id, title, message, alarm.alarm_id || alarm.id, alarm.severity_class, users.map(user => user.id), users.map(user => user.link)]);
      await client.query(`UPDATE machine_alarms SET notification_sent_at=NOW(),
        notification_delivered_priorities=array_append(notification_delivered_priorities,$2) WHERE id=$1
        AND NOT ($2=ANY(notification_delivered_priorities))`, [alarm.alarm_id || alarm.id, alarm.severity_class]);
      delivered++;
      dispatched.add(key);
      for (const user of inserted.rows) recipients.add(user.user_id);
      return true;
    }
    // Lock alarm first, then its events. The same order in the active scan
    // prevents concurrent workers from delivering two priority changes twice.
    const { rows: events } = await client.query(`SELECT e.*,a.notification_delivered_priorities,m.machine_serial_no,m.plant_id,
        COALESCE(p.enabled,FALSE) AS enabled,
        (${ACTIVE}) AS eligible,
        (e.occurred_at>=NOW()-INTERVAL '120 seconds' AND e.occurred_at<=NOW()
          AND e.received_at>=NOW()-INTERVAL '120 seconds' AND e.received_at<=NOW()
          AND e.received_at>=p.enabled_since
          AND e.occurred_at>=date_trunc('second',p.enabled_since)) AS fresh
      FROM alarm_notification_events e JOIN machine_alarms a ON a.id=e.alarm_id AND a.company_id=e.company_id AND a.machine_id=e.machine_id
      JOIN machines m ON m.id=a.machine_id AND m.company_id=a.company_id JOIN companies c ON c.id=a.company_id
      LEFT JOIN alarm_notification_policies p ON p.company_id=m.company_id WHERE e.processed_at IS NULL
      ORDER BY e.checked_at NULLS FIRST,e.id LIMIT $1 FOR UPDATE OF a,e SKIP LOCKED FOR SHARE OF m,c SKIP LOCKED`, [limit]);
    for (const event of events) {
      checked++;
      await client.query('UPDATE alarm_notification_events SET checked_at=NOW() WHERE id=$1', [event.id]);
      let outcome = 'history';
      if (event.severity_class === 'critical' && event.enabled && event.eligible && event.fresh) {
        if (!await deliver(event)) continue; // remains durable until an eligible recipient exists or event expires
        outcome = 'delivered';
      } else if (event.severity_class === 'critical') outcome = 'disabled_stale_or_inactive';
      await client.query('UPDATE alarm_notification_events SET processed_at=NOW(),outcome=$2 WHERE id=$1', [event.id, outcome]);
      progressed++;
    }
    const remaining = limit - checked;
    if (remaining < 1) return;
    const { rows: alarms } = await client.query(`SELECT a.*,a.id AS alarm_id,m.machine_serial_no,m.plant_id,'critical' AS severity_class
      FROM machine_alarms a JOIN machines m ON m.id=a.machine_id AND m.company_id=a.company_id
      JOIN companies c ON c.id=a.company_id JOIN alarm_notification_policies p ON p.company_id=a.company_id AND p.enabled=TRUE
      JOIN LATERAL(SELECT t.alarm,t.device_time,t.received_at FROM telemetry_raw t
        WHERE t.company_id=a.company_id AND t.machine_id=a.machine_id AND t.received_at>=NOW()-INTERVAL '120 seconds'
        ORDER BY t.received_at DESC,t.device_time DESC LIMIT 1) observed
        ON observed.alarm=TRUE AND observed.received_at<=NOW()
        AND observed.device_time>=EXTRACT(EPOCH FROM NOW()-INTERVAL '120 seconds') AND observed.device_time<=EXTRACT(EPOCH FROM NOW())
      LEFT JOIN LATERAL(SELECT g.resumed_at FROM ingest_gaps g WHERE g.company_id=a.company_id AND g.machine_id=a.machine_id
        AND g.resumed_at>=a.started_at ORDER BY g.resumed_at DESC LIMIT 1) gap ON TRUE
      WHERE a.ended_at IS NULL AND ${ACTIVE}
        AND UPPER(BTRIM(a.severity)) IN('CRITICAL','FATAL','EMERGENCY')
        AND NOT ('critical'=ANY(a.notification_delivered_priorities))
        AND to_timestamp(observed.device_time)>=GREATEST(a.started_at,p.enabled_since,gap.resumed_at,
          a.notification_continuity_started_at,a.notification_priority_changed_at)
      ORDER BY a.notification_checked_at NULLS FIRST,a.started_at,a.id
      LIMIT $1 FOR UPDATE OF a SKIP LOCKED FOR SHARE OF m,c SKIP LOCKED`, [remaining]);
    for (const alarm of alarms) {
      checked++;
      await client.query('UPDATE machine_alarms SET notification_checked_at=NOW() WHERE id=$1', [alarm.id]);
      await deliver(alarm);
    }
  });
  if (recipients.size) {
    try { await notifications.announceUnread([...recipients]); }
    catch (error) { console.error('Alarm unread announcement failed:', error.message); }
  }
  return { checked, delivered, recipients: recipients.size, progressed: progressed + delivered };
};

// Events are operational delivery work, not a second permanent alarm history.
// Deduplication remains on the alarm and inbox when processed events expire.
exports.pruneProcessedEvents = async () => {
  const result = await db.query(`DELETE FROM alarm_notification_events WHERE id IN(
    SELECT id FROM alarm_notification_events WHERE processed_at<NOW()-INTERVAL '7 days'
    ORDER BY processed_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
  return result.rowCount;
};
