/*
 * src/db.js — the AI assistant reads, and never writes (23 Oct 2026). Inside
 * pool.readOnly(work) every query, however deep in the services the tool
 * calls, goes through a second pool whose connections start read-only, so
 * PostgreSQL itself refuses a write; outside it nothing changes. pg is faked
 * here: what is checked is which pool each query reaches, and how that
 * pool's connections are opened.
 */
const mockPools = [];
jest.mock('pg', () => ({
  Pool: jest.fn(function Pool(config) {
    this.config = config;
    this.queries = [];
    this.query = jest.fn(async sql => { this.queries.push(sql); return { rows: [] }; });
    this.connect = jest.fn(async () => ({ query: this.query, release: jest.fn() }));
    this.ended = jest.fn();
    this.end = async () => this.ended();          // db.js wraps the main pool's end: count the original
    this.on = jest.fn();
    mockPools.push(this);
  })
}));

let db;
beforeEach(() => {
  mockPools.length = 0;
  jest.isolateModules(() => { db = jest.requireActual('../../src/db'); });
});

const [main, readOnly] = [() => mockPools[0], () => mockPools[1]];

test('outside readOnly: the main pool, as always; no second pool is even opened', async () => {
  await db.query('SELECT 1');
  expect(main().queries).toEqual(['SELECT 1']);
  expect(mockPools).toHaveLength(1);
});

test('inside readOnly: every query — parallel, after a timer, through connect() — reaches the read-only pool', async () => {
  await db.readOnly(async () => {
    await db.query('SELECT a');
    await Promise.all([db.query('SELECT b'), db.query('SELECT c')]);
    await new Promise(r => setTimeout(r, 5));
    await db.query('SELECT d');
    const client = await db.connect();
    await client.query('SELECT e');
    client.release();
  });
  expect(readOnly().config.options).toBe('-c default_transaction_read_only=on');
  expect(readOnly().config.application_name).toBe('iot-api-readonly');
  expect(readOnly().queries).toEqual(['SELECT a', 'SELECT b', 'SELECT c', 'SELECT d', 'SELECT e']);
  expect(main().queries).toEqual([]);

  // and back on the main pool afterwards
  await db.query('UPDATE x SET y = 1');
  expect(main().queries).toEqual(['UPDATE x SET y = 1']);
});

test('a request running beside the read-only work is not caught in it', async () => {
  let release;
  const slow = db.readOnly(() => new Promise(r => { release = r; }).then(() => db.query('SELECT inside')));
  await db.query('INSERT outside');
  release();
  await slow;
  expect(main().queries).toEqual(['INSERT outside']);
  expect(readOnly().queries).toEqual(['SELECT inside']);
});

test('shutting down ends both pools', async () => {
  await db.readOnly(() => db.query('SELECT 1'));
  await db.end();
  expect(readOnly().ended).toHaveBeenCalled();
  expect(main().ended).toHaveBeenCalled();
});
