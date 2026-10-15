const db = require('../db');
const { pagination } = require('../lib/pagination');
const realtime = require('../lib/realtime');

exports.getNotifications = async ({ user_id, company_id, page = 1, limit = 20, unread_only }) => {
  // A reassigned user must never carry a previous company's inbox into their
  // new account context. NULL is the explicit platform/SNT company scope.
  const conditions = [`n.user_id = $1`, `n.company_id IS NOT DISTINCT FROM $2::int`];
  const params = [user_id, company_id ?? null];
  let i = 3;

  if (unread_only === 'true') { conditions.push(`n.is_read = false`); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { pageNum, limitNum, offset } = pagination(page, limit);

  const [countRes, dataRes, unreadRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM notifications n ${where}`, params),
    db.query(
      `SELECT * FROM notifications n ${where} ORDER BY n.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    ),
    db.query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1
      AND company_id IS NOT DISTINCT FROM $2::int AND is_read = false`, params)
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

exports.markRead = async ({ user_id, notification_id, company_id }) => {
  await db.query(
    `UPDATE notifications SET is_read = true, read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND company_id IS NOT DISTINCT FROM $3::int`,
    [notification_id, user_id, company_id ?? null]
  );
};

exports.markAllRead = async (user_id, company_id) => {
  await db.query(
    `UPDATE notifications SET is_read = true, read_at = NOW()
     WHERE user_id = $1 AND company_id IS NOT DISTINCT FROM $2::int AND is_read = false`,
    [user_id, company_id ?? null]
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
      `SELECT n.user_id, COUNT(*)::int AS count
         FROM notifications n
         JOIN users u ON u.id = n.user_id AND n.company_id IS NOT DISTINCT FROM u.company_id
        WHERE n.user_id = ANY($1::int[]) AND n.is_read = false
        GROUP BY n.user_id`,
      [ids]
    );
    const counts = new Map(rows.map(r => [Number(r.user_id), Number(r.count)]));
    for (const id of ids) realtime.emitToUser(id, 'unreadCount', { count: counts.get(id) || 0 });
  } catch (err) {
    console.error('Unread count announce failed:', err.message);
  }
};

exports.getUnreadCount = async (user_id, company_id) => {
  const res = await db.query(
    `SELECT COUNT(*) FROM notifications WHERE user_id = $1
      AND company_id IS NOT DISTINCT FROM $2::int AND is_read = false`,
    [user_id, company_id ?? null]
  );
  return parseInt(res.rows[0].count);
};

/* ─────────────────────────────────────────────────────────
   PER-USER NOTIFICATION PREFERENCES (migration 022)

   Distinct from alert_preferences (company-wide: does an alarm/offline/low
   OEE event create a notification at all). This is per-user: of the
   notifications that exist, which types does this person want surfaced.
   Settings exposes the working alarm receive preference. Other legacy
   fields remain compatible with existing clients and stored choices.
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
