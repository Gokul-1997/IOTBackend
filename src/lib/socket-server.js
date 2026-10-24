const jwt = require('jsonwebtoken');
const { effectivePlantId } = require('./plant-scope');
const { matches, revisionOf } = require('./auth-revision');
const placement = require('./machine-placement');
const { denialForAny } = require('../middleware/access.middleware');

/*
 * Live machine data over Socket.IO, kept inside each company.
 *
 * A socket is authenticated from its token AND the database (a token stays
 * valid for 15 minutes; a disabled user or company must stop getting data at
 * once), and the server puts it in its rooms from that record:
 *   user:<id>        progress meant for one person (program transfer)
 *   company:<id>     company-wide administrators and unassigned users
 *   company:<id>:plant:<id> plant-bound users, from their database record
 *
 * Machine updates used to go to a plant room the client chose by sending
 * `joinPlant` — nothing checked that the plant was the user's, and every
 * machine without a plant (all of a company's machines when its admin
 * created them) went to "plant:null", which any signed-in user could join.
 * `joinPlant` is still accepted from older apps, and ignored. The authorized
 * plant is loaded from the database, including for bounded subscriptions.
 */

function attach(io, { db }) {
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Unauthorized'));
      if (token.startsWith('Bearer ')) token = token.slice(7);

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const { rows } = await db.query(
        `SELECT u.is_active, u.company_id, u.plant_id, u.user_type, u.auth_revision, COALESCE(c.is_active, true) AS company_active
           FROM users u LEFT JOIN companies c ON c.id = u.company_id
          WHERE u.id = $1`,
        [decoded.user_id]
      );
      if (!rows[0]?.is_active || !rows[0].company_active) return next(new Error('Unauthorized'));
      if (!matches(decoded, rows[0])) {
        const error = new Error('TOKEN_EXPIRED');
        error.data = { code: 'AUTH_REVISION_CHANGED' };
        return next(error);
      }

      // the company comes from the database, never from the client
      socket.user = { ...decoded, company_id: rows[0].company_id, plant_id: rows[0].plant_id,
        user_type: rows[0].user_type, auth_revision: revisionOf(rows[0].auth_revision) };
      socket.plantScopeId = effectivePlantId({ ...socket.user, roles: decoded.roles || [] });
      next();
    } catch (err) {
      // a distinct code so the app refreshes its token rather than giving up
      next(new Error(err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // A connection must not outlive the access token which authorized it.
    // Clients already refresh/reconnect after a server disconnect.
    const expiresAt = Number(socket.user?.exp) * 1000;
    let expiryTimer;
    if (Number.isFinite(expiresAt)) {
      const expire = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) return socket.disconnect(true);
        expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        expiryTimer.unref?.();
      };
      expire();
      socket.once('disconnect', () => clearTimeout(expiryTimer));
      if (expiresAt <= Date.now()) return;
    }
    const userId = socket.user?.user_id;
    if (userId) socket.join(`user:${userId}`);

    const companyId = socket.user?.company_id;
    const plantId = socket.plantScopeId;
    const feedRoom = plantId == null ? `company:${companyId}` : `company:${companyId}:plant:${plantId}`;
    // The account can change after handshake authentication and before this
    // socket is registered. Join its revocation room first, then recheck once
    // before exposing a feed. Later committed mutations can now disconnect it.
    const ready = (async () => {
      const { rows } = await db.query(
        `SELECT u.is_active, u.auth_revision, COALESCE(c.is_active, true) AS company_active
           FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1`, [userId]
      );
      if (!socket.connected || !rows[0]?.is_active || !rows[0].company_active || !matches(socket.user, rows[0])) {
        socket.disconnect(true);
        return false;
      }
      // A notification connection is not permission to read machine telemetry.
      // Keep the private user room, but only join data rooms when both the role
      // and the company's page access permit the live dashboards.
      socket.machineFeedAllowed = !!companyId && !await denialForAny(
        { ...socket.user, id: userId }, ['page:dashboard:view', 'page:dashboard:live:view'], db
      );
      if (!socket.connected) return false;
      if (socket.machineFeedAllowed) socket.join(feedRoom);
      return true;
    })().catch(() => { socket.disconnect(true); return false; });

    // New clients opt in to bounded machine subscriptions; old clients keep
    // their company feed. Room names and ownership always come from the server.
    let machineRooms = [];
    let scopeVersion = 0;
    let scopeWindow = Date.now();
    let scopeRequests = 0;
    socket.on('subscribeMachines', async (ids, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (!await ready) return reply({ ok: false, code: 'UNAUTHORIZED' });
      if (!socket.machineFeedAllowed) return reply({ ok: false, code: 'FORBIDDEN' });
      if (Date.now() - scopeWindow >= 1000) { scopeWindow = Date.now(); scopeRequests = 0; }
      if (++scopeRequests > 10) return reply({ ok: false, code: 'RATE_LIMITED' });
      if (!companyId || !Array.isArray(ids) || ids.length > 100 ||
          ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        return reply({ ok: false, code: 'INVALID_SUBSCRIPTION' });
      }
      const version = ++scopeVersion;
      const uniqueIds = [...new Set(ids)];
      try {
        const { rows } = uniqueIds.length ? await db.query(
          'SELECT id FROM machines WHERE company_id = $1 AND id = ANY($2::int[]) AND is_active = true AND ($3::int IS NULL OR plant_id = $3)',
          [companyId, uniqueIds, plantId]
        ) : { rows: [] };
        if (version !== scopeVersion || !socket.connected) return reply({ ok: false, code: 'SUPERSEDED' });
        if (rows.length !== uniqueIds.length) return reply({ ok: false, code: 'FORBIDDEN' });
        // With the current in-process adapter these room operations are synchronous.
        // A distributed adapter rollout must preserve the ordering of scope changes.
        socket.leave(feedRoom);
        for (const room of machineRooms) socket.leave(room);
        // A plant-bound room includes the authorized plant. Moving a machine
        // then stops its updates reaching an old plant's prior subscription.
        machineRooms = rows.map(row => plantId == null
          ? `company:${companyId}:machine:${row.id}`
          : `company:${companyId}:plant:${plantId}:machine:${row.id}`);
        if (machineRooms.length) socket.join(machineRooms);
        reply({ ok: true });
      } catch {
        reply({ ok: false, code: 'SUBSCRIPTION_UNAVAILABLE' });
      }
    });

    socket.on('joinPlant', () => { /* superseded by the company room */ });
  });
}

/** A machine update from the collector (Redis machine_updates) → its company only. */
function relay(io, message) {
  let data;
  try { data = JSON.parse(message); }
  catch (err) { console.error('❌ Invalid JSON from Redis:', err.message); return; }
  // Placement comes from the API's authoritative database snapshot, updated
  // at machine mutation commits. The collector's cached plant cannot route
  // updates to a machine's previous plant during a move.
  const machine = placement.resolve(data);
  if (machine) io.to([
    `company:${machine.company_id}`,
    ...(machine.plant_id != null ? [
      `company:${machine.company_id}:plant:${machine.plant_id}`,
      `company:${machine.company_id}:plant:${machine.plant_id}:machine:${machine.id}`
    ] : []),
    `company:${machine.company_id}:machine:${machine.id}`
  ]).emit('machineUpdate', { ...data, plant_id: machine.plant_id });
}

module.exports = { attach, relay };
