const jwt = require('jsonwebtoken');

/*
 * Live machine data over Socket.IO, kept inside each company.
 *
 * A socket is authenticated from its token AND the database (a token stays
 * valid for 15 minutes; a disabled user or company must stop getting data at
 * once), and the server puts it in its rooms from that record:
 *   user:<id>        progress meant for one person (program transfer)
 *   company:<id>     every machine update of that company
 *
 * Machine updates used to go to a plant room the client chose by sending
 * `joinPlant` — nothing checked that the plant was the user's, and every
 * machine without a plant (all of a company's machines when its admin
 * created them) went to "plant:null", which any signed-in user could join.
 * `joinPlant` is still accepted from older apps, and ignored.
 */

function attach(io, { db }) {
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Unauthorized'));
      if (token.startsWith('Bearer ')) token = token.slice(7);

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const { rows } = await db.query(
        `SELECT u.is_active, u.company_id, COALESCE(c.is_active, true) AS company_active
           FROM users u LEFT JOIN companies c ON c.id = u.company_id
          WHERE u.id = $1`,
        [decoded.user_id]
      );
      if (!rows[0]?.is_active || !rows[0].company_active) return next(new Error('Unauthorized'));

      // the company comes from the database, never from the client
      socket.user = { ...decoded, company_id: rows[0].company_id };
      next();
    } catch (err) {
      // a distinct code so the app refreshes its token rather than giving up
      next(new Error(err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user?.user_id;
    if (userId) socket.join(`user:${userId}`);

    const companyId = socket.user?.company_id;
    if (companyId) socket.join(`company:${companyId}`);

    socket.on('joinPlant', () => { /* superseded by the company room */ });
  });
}

/** A machine update from the collector (Redis machine_updates) → its company only. */
function relay(io, message) {
  let data;
  try { data = JSON.parse(message); }
  catch (err) { console.error('❌ Invalid JSON from Redis:', err.message); return; }
  // a machine with no company reaches nobody
  if (data && data.company_id) io.to(`company:${data.company_id}`).emit('machineUpdate', data);
}

module.exports = { attach, relay };
