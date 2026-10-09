const db = require('../db');
const realtime = require('../lib/realtime');

exports.getNotifications = async ({ user_id, company_id, page = 1, limit = 20, unread_only }) => {
  const conditions = [`n.user_id = $1`];
  const params = [user_id];
  let i = 2;

  if (unread_only === 'true') { conditions.push(`n.is_read = false`); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const [countRes, dataRes, unreadRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM notifications n ${where}`, params),
    db.query(
      `SELECT * FROM notifications n ${where} ORDER BY n.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    ),
    db.query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`, [user_id])
  ]);

  return {
    data: dataRes.rows,
    unread_count: parseInt(unreadRes.rows[0].count),
    pagination: {
      page: pageNum, limit: limitNum,
      total: parseInt(countRes.rows[0].count),
      totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum)
    }
  };
};

exports.markRead = async ({ user_id, notification_id }) => {
  await db.query(
    `UPDATE notifications SET is_read = true, read_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [notification_id, user_id]
  );
};

exports.markAllRead = async (user_id) => {
  await db.query(
    `UPDATE notifications SET is_read = true, read_at = NOW()
     WHERE user_id = $1 AND is_read = false`,
    [user_id]
  );
};

/**
 * Tell these people's open screens their unread count, over the live
 * connection (event `unreadCount`, room user:<id>): after notifications are
 * created for them, and after they read some — so every tab and device they
 * have open shows the new count at once, without asking the server every
 * few seconds. One query for all of them; a user with nothing unread is told
 * 0. Best effort: a failure here never fails what caused it.
 */
exports.announceUnread = async (userIds = []) => {
  if (!realtime.isLive()) return;
  const ids = [...new Set(userIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  try {
    const { rows } = await db.query(
      `SELECT user_id, COUNT(*)::int AS count
         FROM notifications
        WHERE user_id = ANY($1::int[]) AND is_read = false
        GROUP BY user_id`,
      [ids]
    );
    const counts = new Map(rows.map(r => [Number(r.user_id), Number(r.count)]));
    for (const id of ids) realtime.emitToUser(id, 'unreadCount', { count: counts.get(id) || 0 });
  } catch (err) {
    console.error('Unread count announce failed:', err.message);
  }
};

exports.getUnreadCount = async (user_id) => {
  const res = await db.query(
    `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
    [user_id]
  );
  return parseInt(res.rows[0].count);
};

/* ─────────────────────────────────────────────────────────
   PER-USER NOTIFICATION PREFERENCES (migration 022)

   Distinct from alert_preferences (company-wide: does an alarm/offline/low
   OEE event create a notification at all). This is per-user: of the
   notifications that exist, which types does this person want surfaced.
───────────────────────────────────────────────────────── */

const DEFAULT_PREFS = {
  notify_alarm: true, notify_maintenance: true, notify_ticket: true,
  notify_program_transfer: true, notify_system: true, email_digest: false
};

/** Created lazily so a user who never opens Settings costs nothing. */
exports.getPreferences = async (userId) => {
  const { rows } = await db.query('SELECT * FROM notification_preferences WHERE user_id = $1', [userId]);
  if (rows.length) {
    const { user_id, updated_at, ...prefs } = rows[0];
    return prefs;
  }
  return { ...DEFAULT_PREFS };
};

exports.updatePreferences = async (userId, patch) => {
  const allowed = Object.keys(DEFAULT_PREFS);
  const fields = allowed.filter(k => patch[k] !== undefined);
  if (!fields.length) throw { status: 400, message: 'Nothing to update' };

  const values = fields.map(k => !!patch[k]);
  const insertCols = ['user_id', ...fields].join(', ');
  const insertVals = ['$1', ...fields.map((_, i) => `$${i + 2}`)].join(', ');
  const updateSet = fields.map(k => `${k} = EXCLUDED.${k}`).join(', ');

  const { rows } = await db.query(
    `INSERT INTO notification_preferences (${insertCols})
     VALUES (${insertVals})
     ON CONFLICT (user_id) DO UPDATE SET ${updateSet}, updated_at = NOW()
     RETURNING *`,
    [userId, ...values]
  );
  const { user_id, updated_at, ...prefs } = rows[0];
  return prefs;
};
