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

process.env.JWT_SECRET = 'socket-test-secret';

// users 1 (company 4), 2 (company 5), 3 (disabled), 4 (company 6, disabled company)
const USERS = {
  1: { is_active: true, company_id: 4, company_active: true },
  2: { is_active: true, company_id: 5, company_active: true },
  3: { is_active: false, company_id: 4, company_active: true },
  4: { is_active: true, company_id: 6, company_active: false }
};
const db = { query: async (sql, [id, ids]) => ({ rows: sql.includes('FROM machines')
  ? (ids || []).filter(machineId => ({ 101: 4, 102: 4, 201: 5 })[machineId] === id).map(id => ({ id }))
  : USERS[id] ? [USERS[id]] : [] }) };

let httpServer, io, url;
const clients = [];

beforeAll(done => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  socketServer.attach(io, { db });
  httpServer.listen(0, () => { url = `http://127.0.0.1:${httpServer.address().port}`; done(); });
});
afterAll(done => { for (const c of clients) c.close(); io.close(); httpServer.close(done); });

/** A client signed in as `userId`; `claims` can lie about the company. */
function client(userId, claims = {}) {
  const token = jwt.sign({ user_id: userId, ...claims }, process.env.JWT_SECRET);
  const c = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  clients.push(c);
  return c;
}
const connected = c => new Promise((resolve, reject) => { c.on('connect', resolve); c.on('connect_error', reject); });
const updatesOf = c => { const got = []; c.on('machineUpdate', d => got.push(d.machine_id)); return got; };
const settle = () => new Promise(r => setTimeout(r, 150));
const subscribe = (c, ids) => new Promise((resolve, reject) => c.timeout(1000).emit('subscribeMachines', ids, (err, reply) => err ? reject(err) : resolve(reply)));

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
