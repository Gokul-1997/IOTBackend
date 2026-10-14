const placements = require('../../src/lib/machine-placement');
const { startListening } = require('../../src/lib/start-listening');
const { EventEmitter } = require('events');

const row = (patch = {}) => ({ id: 7, company_id: 4, plant_id: 8, is_active: true, ...patch });
const payload = (patch = {}) => ({ machine_id: 7, company_id: 4, plant_id: 8, ...patch });
const dbWith = rows => ({ query: jest.fn().mockResolvedValue({ rows }) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(async () => { await placements.load(dbWith([row()])); });

test('current database plant controls routing even when collector metadata is stale', () => {
  placements.upsert(row({ plant_id: 10 }));
  expect(placements.resolve(payload()).plant_id).toBe(10);
  expect(placements.resolve(payload({ plant_id: null })).plant_id).toBe(10);
});

test('unknown, inactive, malformed and other-company payloads reach nobody', () => {
  expect(placements.resolve(payload({ machine_id: 99 }))).toBeNull();
  expect(placements.resolve(payload({ company_id: 5 }))).toBeNull();
  expect(placements.resolve(payload({ company_id: null }))).toBeNull();
  expect(placements.resolve([])).toBeNull();
  expect(placements.resolve('payload')).toBeNull();
  placements.upsert(row({ is_active: false }));
  expect(placements.resolve(payload())).toBeNull();
  placements.remove(7);
  expect(placements.resolve(payload())).toBeNull();
});

test('a pending mutation suspends routing until its committed placement has been refreshed', async () => {
  const token = placements.begin(7);
  expect(placements.resolve(payload())).toBeNull();
  const pending = deferred();
  const db = { query: jest.fn().mockReturnValue(pending.promise) };
  const refresh = placements.finish(token, db);
  expect(placements.resolve(payload())).toBeNull();
  pending.resolve({ rows: [row({ plant_id: 10 })] });
  await refresh;
  expect(placements.resolve(payload()).plant_id).toBe(10);
  await placements.finish(token, db);
  expect(db.query).toHaveBeenCalledTimes(1);
});

test('overlapping writes refresh only after the last settles and use the final database row', async () => {
  const first = placements.begin(7), second = placements.begin(7);
  const db = dbWith([row({ plant_id: 10 })]);
  await placements.finish(second, db);
  expect(db.query).not.toHaveBeenCalled();
  expect(placements.resolve(payload())).toBeNull();
  await placements.finish(first, db);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(placements.resolve(payload()).plant_id).toBe(10);
});

test('a newer mutation during refresh prevents the earlier response reopening a stale route', async () => {
  const firstRead = deferred();
  const db = { query: jest.fn().mockReturnValueOnce(firstRead.promise).mockResolvedValueOnce({ rows: [row({ plant_id: 11 })] }) };
  const first = placements.begin(7);
  const firstRefresh = placements.finish(first, db);
  const second = placements.begin(7);
  firstRead.resolve({ rows: [row({ plant_id: 10 })] });
  await firstRefresh;
  expect(placements.resolve(payload())).toBeNull();
  await placements.finish(second, db);
  expect(placements.resolve(payload()).plant_id).toBe(11);
});

test('rollback restores database placement; deletion and failed refresh keep routing closed', async () => {
  await placements.finish(placements.begin(7), dbWith([row()]));
  expect(placements.resolve(payload()).plant_id).toBe(8);
  await placements.finish(placements.begin(7), dbWith([]));
  expect(placements.resolve(payload())).toBeNull();
  placements.upsert(row());
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const db = { query: jest.fn().mockRejectedValue(new Error('unavailable')) };
  await placements.finish(placements.begin(7), db);
  expect(placements.resolve(payload())).toBeNull();
  expect(log).toHaveBeenCalled();
  log.mockRestore();
  // A later successful edit can recover just this machine without reopening
  // any route on the failed refresh.
  await placements.finish(placements.begin(7), dbWith([row({ plant_id: 10 })]));
  expect(placements.resolve(payload()).plant_id).toBe(10);
});

test('startup never listens when authoritative machine placements cannot be loaded', async () => {
  const server = new EventEmitter();
  server.listen = jest.fn();
  const db = { query: jest.fn().mockRejectedValue(new Error('database unavailable')) };
  await expect(startListening(server, db, 8000)).rejects.toThrow('database unavailable');
  expect(server.listen).not.toHaveBeenCalled();
  expect(placements.resolve(payload())).toBeNull();
});

test('invalid startup placement fails closed; valid loading finishes before opening the listener', async () => {
  await expect(placements.load(dbWith([row({ company_id: null })]))).rejects.toThrow('invalid owner');
  expect(placements.resolve(payload())).toBeNull();
  const server = new EventEmitter();
  server.listen = jest.fn((port, done) => {
    expect(placements.resolve(payload()).plant_id).toBe(8);
    done();
  });
  await startListening(server, dbWith([row()]), 8000);
  expect(server.listen).toHaveBeenCalledWith(8000, expect.any(Function));
});
