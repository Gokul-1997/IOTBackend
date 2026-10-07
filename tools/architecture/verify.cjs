/* Isolated PostgreSQL verification. Never loads application env files.
 * Run only against a disposable local database named cnc_architecture_test:
 * ARCHITECTURE_TEST_URL=postgres://.../cnc_architecture_test node tools/architecture/verify.cjs
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Pool } = require('pg');

async function main() {
  const address = new URL(process.env.ARCHITECTURE_TEST_URL || '');
  assert.ok(['127.0.0.1', 'localhost'].includes(address.hostname), 'Local test database only');
  assert.equal(address.pathname, '/cnc_architecture_test', 'Disposable database name required');
  const pool = new Pool({ connectionString: address.href, max: 4, options: '-c search_path=architecture_fixture' });
  let createdFixture = false;
  try {
    await pool.query('CREATE SCHEMA architecture_fixture');
    createdFixture = true;
    await pool.query(`
      CREATE TABLE machines (id integer PRIMARY KEY, company_id integer, machine_serial_no text, image_url text, is_active boolean);
      CREATE TABLE telemetry_raw (machine_id integer, company_id integer, machine_status text, alarm boolean, received_at timestamptz, device_time bigint);
      CREATE INDEX ON telemetry_raw(company_id, machine_id, received_at DESC);
      CREATE TABLE shifts(id integer, company_id integer, shift_code text, start_time time, end_time time, break_minutes integer, is_active boolean);
      CREATE TABLE operators(id integer, operator_name text, is_active boolean);
      CREATE TABLE operator_machine_assignments(machine_id integer, operator_id integer, is_active boolean);
      CREATE TABLE operator_shift_assignments(operator_id integer, shift_id integer, is_active boolean);
      CREATE TABLE machine_current_job(machine_id integer, component_id integer, part_name text, target_qty integer, is_active boolean);
      CREATE TABLE components(id integer, multiplication_factor integer);
      CREATE TABLE production_hourly(company_id integer, machine_id integer, shift_id integer, hour_start timestamptz,
        run_seconds integer, idle_seconds integer, manual_seconds integer, produced_qty integer, energy_kwh double precision,
        PRIMARY KEY(machine_id,shift_id,hour_start));
      CREATE TABLE ingest_checkpoint(collector_id text PRIMARY KEY, last_seq bigint NOT NULL, updated_at timestamptz DEFAULT now());
      INSERT INTO shifts VALUES(1,4,'DAY','00:00:00','23:59:59',0,true);
      INSERT INTO machines SELECT i, CASE WHEN i <= 200 THEN 4 ELSE 5 END, 'CNC-' || i, null, true FROM generate_series(1,220) i;
      INSERT INTO telemetry_raw SELECT id, company_id, CASE WHEN id % 2 = 0 THEN 'RUNNING' ELSE 'IDLE' END,
        id % 5 = 0, now() - CASE WHEN id % 10 = 0 THEN interval '2 minutes' ELSE interval '1 second' END, id FROM machines;
    `);
    // Inject the explicit local pool before importing services; do not load src/db.js/.env.
    const dbFile = require.resolve('../../src/db');
    require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: pool };
    const { fleetPage, parseFleetPage } = require('../../src/dashboard/fleet-page');
    const dashboard = require('../../src/dashboard/dashboard.service');
    const first = await fleetPage(4, parseFleetPage({ paged: '1', per_page: '25' }));
    assert.equal(first.machines.length, 25);
    assert.deepEqual(first.summary, { total: 200, running: 80, idle: 100, offline: 20, alarm: 40 });
    const second = await fleetPage(4, parseFleetPage({ paged: '1', page: '2', per_page: '25' }));
    assert.equal(second.machines[0].id, 26);
    const running = await fleetPage(4, parseFleetPage({ paged: '1', status: 'running', per_page: '100' }));
    assert.equal(running.pagination.total, 80);
    assert.ok(running.machines.every(m => m.status === 'RUNNING' && m.id <= 200));
    const foreign = await fleetPage(4, parseFleetPage({ paged: '1', search: 'CNC-201' }));
    assert.equal(foreign.machines.length, 0);
    const literal = await fleetPage(4, parseFleetPage({ paged: '1', search: '%' }));
    assert.equal(literal.pagination.total, 0);
    const empty = await fleetPage(4, parseFleetPage({ paged: '1', page: '1000' }));
    assert.equal(empty.machines.length, 0); assert.equal(empty.summary.total, 200);
    const detailPage = await dashboard.dashboard(null, 4, parseFleetPage({ paged: '1', per_page: '6' }));
    assert.equal(detailPage.machines.length, 6); assert.equal(detailPage.summary.total, 200);
    console.log('PASS real PostgreSQL: page bounds, whole-fleet counts, status/search, tenant isolation, empty pages, dashboard service');

    const { createFlusher } = await import(pathToFileURL(path.resolve(__dirname, '../../../pms-backend/src/lib/flusher.js')));
    const record = { s: 123, r: { machine_id: 900, company_id: 4, device_time: 123 },
      h: [{ company_id: 4, machine_id: 900, shift_id: 1, hour_start: 1000, run: 1, idle: 0, manual: 0, produced: 1, energy: 0 }] };
    const journal = () => {
      let waiting = true;
      return { read: () => ({ records: waiting ? [record] : [], position: {} }), ack: () => { waiting = false; } };
    };
    const insert = rows => ({ text: 'INSERT INTO telemetry_raw(machine_id, company_id, device_time) VALUES ($1,$2,$3)',
      values: [rows[0].machine_id, rows[0].company_id, rows[0].device_time] });
    let loseReply = true;
    const uncertainPool = { connect: async () => {
      const client = await pool.connect();
      return { release: error => client.release(error), query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (sql === 'COMMIT' && loseReply) { loseReply = false; throw new Error('COMMIT reply lost'); }
        return result;
      } };
    } };
    const flusher = createFlusher({ pool: uncertainPool, journal: journal(), collectorId: 'test-collector', telemetryInsert: insert });
    await assert.rejects(flusher.pass(), /reply lost/);
    await flusher.pass();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM telemetry_raw WHERE machine_id=900')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT produced_qty FROM production_hourly WHERE machine_id=900')).rows[0].produced_qty, 1);
    // Independent writer objects race on one durable checkpoint. Both see the same journal record.
    const options = { pool, collectorId: 'racing-collector', telemetryInsert: insert };
    await Promise.all([
      createFlusher({ ...options, journal: journal() }).pass(),
      createFlusher({ ...options, journal: journal() }).pass()
    ]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM telemetry_raw WHERE machine_id=900')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT produced_qty FROM production_hourly WHERE machine_id=900')).rows[0].produced_qty, 2);
    console.log('PASS real PostgreSQL: lost COMMIT reply and concurrent checkpoint locking preserve one write per collector record');
  } finally {
    if (createdFixture) await pool.query('DROP SCHEMA architecture_fixture CASCADE').catch(() => {});
    await pool.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
