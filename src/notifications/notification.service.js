const db = require('../db');

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

exports.getUnreadCount = async (user_id) => {
  const res = await db.query(
    `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
    [user_id]
  );
  return parseInt(res.rows[0].count);
};
