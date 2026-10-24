/*
 * Live machine data stays inside its company — over a real Socket.IO server
 * and real clients.
 *
 * Before: machine updates went to a plant room the client chose with
 * `joinPlant`, so any signed-in user could name another company's plant, and
 * machines with no plant (all of a company's machines when its admin created
 * them) broadcast to "plant:null", which anyone could join.
 */
const http = require('http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const socketServer = require('../../src/lib/socket-server');
const placement = require('../../src/lib/machine-placement');
const MACHINES = [
  { id: 101, company_id: 4, plant_id: 11, is_active: true },
  { id: 102, company_id: 4, plant_id: 12, is_active: true },
  { id: 103, company_id: 4, plant_id: null, is_active: true },
  { id: 201, company_id: 5, plant_id: 21, is_active: true }
];

process.env.JWT_SECRET = 'socket-test-secret';

// users 1 (company 4), 2 (company 5), 3 (disabled), 4 (company 6, disabled company)
const USERS = {
  1: { is_active: true, company_id: 4, company_active: true },
  2: { is_active: true, company_id: 5, company_active: true },
  3: { is_active: false, company_id: 4, company_active: true },
  4: { is_active: true, company_id: 6, company_active: false },
  5: { is_active: true, company_id: 4, plant_id: 11, company_active: true },
  6: { is_active: true, company_id: 4, plant_id: 12, company_active: true },
  7: { is_active: true, company_id: 4, company_active: true, auth_revision: '1' },
  8: { is_active: true, company_id: 4, company_active: true, auth_revision: '9007199254740993' },
  9: { is_active: true, company_id: 4, company_active: true, auth_revision: '0' },
  10: { is_active: true, company_id: 4, company_active: true },
  11: { is_active: true, company_id: 4, company_active: true }
};
let companyGrants = [];
let raceReads = 0;
const db = { query: async (sql, [id, ids, plantId]) => ({ rows: sql.includes('FROM company_permissions')
  ? companyGrants.map(permission_key => ({ permission_key })) : sql.includes('FROM machines')
  ? (ids || []).filter(machineId => ({ 101: 4, 102: 4, 201: 5 })[machineId] === id && (plantId == null || ({101: 11, 102: 12})[machineId] === plantId)).map(id => ({ id }))
  : USERS[id] ? [{ ...USERS[id], ...(id === 9 && ++raceReads > 1 ? { auth_revision: '1' } : {}) }] : [] }) };

let httpServer, io, url;
const clients = [];
beforeEach(async () => { companyGrants = []; await placement.load({ query: async () => ({ rows: MACHINES }) }); });

beforeAll(done => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  socketServer.attach(io, { db });
  httpServer.listen(0, () => { url = `http://127.0.0.1:${httpServer.address().port}`; done(); });
});
afterAll(done => { for (const c of clients) c.close(); io.close(); httpServer.close(done); });

/** A client signed in as `userId`; `claims` can lie about the company. */
function client(userId, claims = {}) {
  const token = jwt.sign({ user_id: userId, permissions: ['page:dashboard:view'], ...claims }, process.env.JWT_SECRET);
  const c = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  clients.push(c);
  return c;
}
const connected = c => new Promise((resolve, reject) => { c.on('connect', resolve); c.on('connect_error', reject); });
const updatesOf = c => { const got = []; c.on('machineUpdate', d => got.push(d.machine_id)); return got; };
const settle = () => new Promise(r => setTimeout(r, 150));
const subscribe = (c, ids) => new Promise((resolve, reject) => c.timeout(1000).emit('subscribeMachines', ids, (err, reply) => err ? reject(err) : resolve(reply)));

test.each([undefined, '0'])('stale revision %s refuses socket handshake with a refreshable error', async auth_revision => {
  const c = client(7, { roles: ['COMPANY_ADMIN'], auth_revision });
  await expect(connected(c)).rejects.toMatchObject({ message: 'TOKEN_EXPIRED', data: { code: 'AUTH_REVISION_CHANGED' } });
  c.close();
});

test('socket BIGINT revision stays exact rather than rounding through Number', async () => {
  const valid = client(8, { auth_revision: '9007199254740993' });
  await connected(valid); valid.close();
  const stale = client(8, { auth_revision: '9007199254740992' });
  await expect(connected(stale)).rejects.toMatchObject({ message: 'TOKEN_EXPIRED', data: { code: 'AUTH_REVISION_CHANGED' } });
  stale.close();
});

test('a revision changed between handshake and joining feed rooms closes the new socket', async () => {
  raceReads = 0;
  const c = client(9, { auth_revision: '0' });
  const disconnected = new Promise(resolve => c.once('disconnect', resolve));
  await connected(c);
  expect(await disconnected).toBe('io server disconnect');
  c.close();
});

test('bounded subscriptions receive only selected machines, can change and unsubscribe', async () => {
  const c = client(1); await connected(c);
  const got = updatesOf(c);
  expect(await subscribe(c, [101])).toEqual({ ok: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4 }));
  socketServer.relay(io, JSON.stringify({ machine_id: 102, company_id: 4 }));
  await settle();
  expect(got).toEqual([101]);
  expect(await subscribe(c, [102])).toEqual({ ok: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4 }));
  socketServer.relay(io, JSON.stringify({ machine_id: 102, company_id: 4 }));
  await settle();
  expect(got).toEqual([101, 102]);
  expect(await subscribe(c, [])).toEqual({ ok: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 102, company_id: 4 }));
  await settle();
  expect(got).toEqual([101, 102]);
  c.close();
});

test('a notification-only account cannot listen to or subscribe to machine telemetry', async () => {
  const c = client(10, { permissions: ['page:quality:view'] }); await connected(c);
  const got = updatesOf(c);
  expect(await subscribe(c, [101])).toEqual({ ok: false, code: 'FORBIDDEN' });
  const unread = new Promise(resolve => c.once('unreadCount', resolve));
  io.to('user:10').emit('unreadCount', { count: 3 });
  expect(await unread).toEqual({ count: 3 });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4 }));
  await settle(); expect(got).toEqual([]); c.close();
});

test('a role grant cannot bypass the company withholding dashboard access', async () => {
  companyGrants = ['page:quality:view'];
  const c = client(11, { roles: ['COMPANY_ADMIN'] }); await connected(c);
  const got = updatesOf(c);
  expect(await subscribe(c, [101])).toEqual({ ok: false, code: 'FORBIDDEN' });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4 }));
  await settle(); expect(got).toEqual([]); c.close();
});

test('foreign IDs and oversized subscriptions are rejected without leaking data', async () => {
  const c = client(1); await connected(c);
  const got = updatesOf(c);
  await subscribe(c, []);
  expect(await subscribe(c, [201])).toEqual({ ok: false, code: 'FORBIDDEN' });
  expect(await subscribe(c, Array(101).fill(101))).toEqual({ ok: false, code: 'INVALID_SUBSCRIPTION' });
  socketServer.relay(io, JSON.stringify({ machine_id: 201, company_id: 5 }));
  await settle();
  expect(got).toEqual([]);
  c.close();
});

test('each company receives its own machines and nothing else, whatever the client asks for', async () => {
  const a = client(1);
  const b = client(2, { company_id: 4, plant_id: 1 });     // a token claiming company 4 does not get company 4
  await Promise.all([connected(a), connected(b)]);
  const gotA = updatesOf(a), gotB = updatesOf(b);

  // the old ways in: name the other company's plant, or the room every unplanted machine used
  b.emit('joinPlant', 1);
  b.emit('joinPlant', null);
  await settle();

  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4, plant_id: 1 }));
  socketServer.relay(io, JSON.stringify({ machine_id: 201, company_id: 5, plant_id: null }));
  socketServer.relay(io, JSON.stringify({ machine_id: 999, company_id: null, plant_id: 1 }));   // no company: nobody
  await settle();

  expect(gotA).toEqual([101]);
  expect(gotB).toEqual([201]);
});

test('a disabled user, or anyone in a disabled company, is refused', async () => {
  await expect(connected(client(3))).rejects.toThrow('Unauthorized');
  await expect(connected(client(4))).rejects.toThrow('Unauthorized');
});

test('no token, or a forged one, is refused; an expired one says so', async () => {
  const none = connect(url, { transports: ['websocket'], reconnection: false });
  clients.push(none);
  await expect(connected(none)).rejects.toThrow('Unauthorized');

  const forged = connect(url, { auth: { token: jwt.sign({ user_id: 1 }, 'not-the-secret') }, transports: ['websocket'], reconnection: false });
  clients.push(forged);
  await expect(connected(forged)).rejects.toThrow('Unauthorized');

  const expired = connect(url, { auth: { token: jwt.sign({ user_id: 1, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET) },
    transports: ['websocket'], reconnection: false });
  clients.push(expired);
  await expect(connected(expired)).rejects.toThrow('TOKEN_EXPIRED');
});

test('a malformed message from Redis is ignored, not thrown', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => socketServer.relay(io, '{not json')).not.toThrow();
  spy.mockRestore();
});


test('same-company plant users get their own feed and cannot subscribe outside it', async () => {
  const first = client(5, { plant_id: 12 });
  const second = client(6, { plant_id: 11 });
  const admin = client(5, { roles: ['COMPANY_ADMIN'] });
  await Promise.all([connected(first), connected(second), connected(admin)]);
  const a = updatesOf(first), b = updatesOf(second), all = updatesOf(admin);
  first.emit('joinPlant', 12);
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4, plant_id: 11 }));
  socketServer.relay(io, JSON.stringify({ machine_id: 102, company_id: 4, plant_id: 12 }));
  socketServer.relay(io, JSON.stringify({ machine_id: 103, company_id: 4, plant_id: null }));
  await settle();
  expect(a).toEqual([101]); expect(b).toEqual([102]); expect(all).toEqual([101, 102, 103]);
  expect(await subscribe(first, [102])).toEqual({ ok: false, code: 'FORBIDDEN' });
  expect(await subscribe(first, [101])).toEqual({ ok: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 102, company_id: 4, plant_id: 12 }));
  await settle(); expect(a).toEqual([101]);
  first.close();second.close();admin.close();
});

test('a machine moved to another plant stops reaching its old plant-bound subscription', async () => {
  const first = client(5); const admin = client(1, { roles: ['COMPANY_ADMIN'] });
  await Promise.all([connected(first), connected(admin)]);
  const plantUpdates = updatesOf(first); const companyUpdates = updatesOf(admin);
  expect(await subscribe(first, [101])).toEqual({ ok: true });
  expect(await subscribe(admin, [101])).toEqual({ ok: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4, plant_id: 11 }));
  placement.upsert({ id: 101, company_id: 4, plant_id: 12, is_active: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4, plant_id: 12 }));
  placement.upsert({ id: 101, company_id: 4, plant_id: null, is_active: true });
  socketServer.relay(io, JSON.stringify({ machine_id: 101, company_id: 4, plant_id: null }));
  await settle();
  expect(plantUpdates).toEqual([101]); expect(companyUpdates).toEqual([101, 101, 101]);
  first.close(); admin.close();
});
