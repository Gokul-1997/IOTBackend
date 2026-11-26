#!/usr/bin/env node
'use strict';
/* Optional PostgreSQL integration check. Example:
 * node scripts/verify-energy-quality-migration.js postgres://codex@127.0.0.1:45473/postgres
 * Deliberately refuses remote databases and never loads application .env.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function verify(connectionString) {
  if (!connectionString) throw new Error('An explicit disposable localhost PostgreSQL URL is required');
  const target = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || target.search || target.hash) {
    throw new Error('This verification only accepts a plain localhost PostgreSQL URL');
  }
  const schema = `energy_quality_verify_${process.pid}_${Date.now()}`;
  const source = fs.readFileSync(path.join(__dirname, '../src/dashboard/energy-meter.service.js'), 'utf8');
  const definition = source.match(/const READING_COLUMNS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(definition, 'meter column definition must remain discoverable without loading database configuration');
  const columns = [...definition[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map(match => match[1]);
  assert.ok(columns.length > 50);
  const migration = fs.readFileSync(path.join(__dirname, '../src/migrations/070_energy_quality_retention.sql'), 'utf8');
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    application_name: 'energy-quality-local-verification' });
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path="${schema}",pg_catalog`);
    await client.query(`CREATE TABLE companies(id INTEGER PRIMARY KEY);
      INSERT INTO companies VALUES(4),(5);
      CREATE TABLE energy_meter_readings(company_id INTEGER,machine_id INTEGER,read_at TIMESTAMPTZ,
        ${columns.map(column => `"${column}" DOUBLE PRECISION`).join(',')},standalone_fields TEXT[] DEFAULT '{}');
      CREATE TABLE telemetry_raw(company_id INTEGER,machine_id INTEGER,received_at TIMESTAMPTZ,
        device_time DOUBLE PRECISION,energy DOUBLE PRECISION,voltage DOUBLE PRECISION,
        current DOUBLE PRECISION,power DOUBLE PRECISION,parts_count INTEGER);
      CREATE TABLE telemetry_late(company_id INTEGER,machine_id INTEGER,received_at TIMESTAMPTZ,
        device_time DOUBLE PRECISION,payload JSONB);
      CREATE TABLE production_hourly(company_id INTEGER,machine_id INTEGER,hour_start TIMESTAMPTZ,
        energy_kwh DOUBLE PRECISION,produced_qty INTEGER,run_seconds INTEGER);
      CREATE TABLE ingest_gaps(company_id INTEGER,machine_id INTEGER,resumed_at TIMESTAMPTZ,
        unallocated_energy_kwh DOUBLE PRECISION,unallocated_parts INTEGER);
      CREATE TABLE energy_meter_latest(company_id INTEGER,machine_id INTEGER,field_values JSONB,
        field_observed_at JSONB,updated_at TIMESTAMPTZ);
      CREATE TABLE queued(company_id INTEGER,machine_id INTEGER,read_at TIMESTAMPTZ);
      CREATE FUNCTION energy_enqueue(INTEGER,INTEGER,TIMESTAMPTZ) RETURNS VOID LANGUAGE SQL AS
        'INSERT INTO queued VALUES($1,$2,$3)';`);
    await client.query(migration);
    await client.query(migration);
    const lateIndex=fs.readFileSync(path.join(__dirname,'../src/migrations/071_energy_late_observed_index.sql'),'utf8');
    await client.query(lateIndex);await client.query(lateIndex);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',
      [schema,'telemetry_late_company_observed_energy'])).rows[0].n,1);
    const chunkFix=fs.readFileSync(path.join(__dirname,'../src/migrations/072_energy_chunk_trigger_dispatch.sql'),'utf8');
    await client.query(chunkFix);await client.query(chunkFix);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM energy_history_policy')).rows[0].n, 0,
      'installation must not enable a retention policy or delete tenant data');
    await client.query(`INSERT INTO energy_history_policy(company_id,retention_days,enabled) VALUES(4,5,TRUE)`);
    await client.query(`INSERT INTO energy_meter_readings(company_id,machine_id,read_at,kwh_total)
      VALUES(4,19,NOW()-INTERVAL '6 days',100),(5,19,NOW()-INTERVAL '6 days',200)`);
    assert.deepEqual((await client.query('SELECT company_id,kwh_total FROM energy_meter_readings')).rows,
      [{ company_id: 5, kwh_total: 200 }], 'only opted-in tenant old energy is rejected');
    await client.query(`INSERT INTO telemetry_raw(company_id,machine_id,received_at,device_time,
      energy,voltage,current,power,parts_count) VALUES
      (4,19,NOW(),EXTRACT(EPOCH FROM NOW()-INTERVAL '6 days'),100,415,1,2,37),
      (5,19,NOW(),EXTRACT(EPOCH FROM NOW()-INTERVAL '6 days'),200,416,2,-1,38)`);
    await client.query(`CREATE TABLE meter_chunk_fixture(LIKE energy_meter_readings INCLUDING ALL);
      CREATE TRIGGER energy_guard BEFORE INSERT OR UPDATE ON meter_chunk_fixture FOR EACH ROW EXECUTE FUNCTION energy_guard_measurements();
      CREATE TABLE raw_chunk_fixture(LIKE telemetry_raw INCLUDING ALL);
      CREATE TRIGGER energy_guard BEFORE INSERT OR UPDATE ON raw_chunk_fixture FOR EACH ROW EXECUTE FUNCTION energy_guard_measurements();
      CREATE TABLE hourly_chunk_fixture(LIKE production_hourly INCLUDING ALL);
      CREATE TRIGGER energy_guard BEFORE INSERT OR UPDATE ON hourly_chunk_fixture FOR EACH ROW EXECUTE FUNCTION energy_guard_shared_history();
      INSERT INTO meter_chunk_fixture(company_id,machine_id,read_at,kwh_total,kw_total,v_ll_avg)
      VALUES(4,19,NOW(),100,-0.199,1e31),(4,19,NOW()-INTERVAL '6 days',100,1,415);
      INSERT INTO raw_chunk_fixture(company_id,machine_id,received_at,device_time,energy,parts_count)
      VALUES(4,19,NOW(),EXTRACT(EPOCH FROM NOW()-INTERVAL '6 days'),100,37);
      INSERT INTO hourly_chunk_fixture VALUES(4,19,NOW()-INTERVAL '6 days',100,12,3600);`);
    assert.deepEqual((await client.query('SELECT kwh_total,kw_total,v_ll_avg FROM meter_chunk_fixture')).rows,
      [{kwh_total:100,kw_total:-0.199,v_ll_avg:null}], 'meter chunks must use meter fields, not CNC device_time');
    assert.deepEqual((await client.query('SELECT energy,parts_count FROM raw_chunk_fixture')).rows,
      [{energy:null,parts_count:37}]);
    assert.deepEqual((await client.query('SELECT energy_kwh,produced_qty,run_seconds FROM hourly_chunk_fixture')).rows,
      [{energy_kwh:0,produced_qty:12,run_seconds:3600}]);
    const oldCnc = (await client.query('SELECT company_id,energy,voltage,current,power,parts_count FROM telemetry_raw ORDER BY company_id')).rows;
    assert.deepEqual(oldCnc, [
      { company_id: 4, energy: null, voltage: null, current: null, power: null, parts_count: 37 },
      { company_id: 5, energy: 200, voltage: 416, current: 2, power: -1, parts_count: 38 }
    ], 'CNC rows and parts must survive retention; other company energy stays intact');
    await client.query(`INSERT INTO production_hourly VALUES
      (4,19,NOW()-INTERVAL '6 days',8,12,3600),(5,19,NOW()-INTERVAL '6 days',9,13,3400);
      INSERT INTO ingest_gaps VALUES
      (4,19,NOW()-INTERVAL '6 days',8,12),(5,19,NOW()-INTERVAL '6 days',9,13);
      UPDATE production_hourly SET energy_kwh=99 WHERE company_id=4;
      UPDATE ingest_gaps SET unallocated_energy_kwh=99 WHERE company_id=4;`);
    assert.deepEqual((await client.query('SELECT company_id,energy_kwh,produced_qty,run_seconds FROM production_hourly ORDER BY company_id')).rows,
      [{company_id:4,energy_kwh:0,produced_qty:12,run_seconds:3600},
        {company_id:5,energy_kwh:9,produced_qty:13,run_seconds:3400}],
      'old journal replays must not restore expired production energy or change production');
    assert.deepEqual((await client.query('SELECT company_id,unallocated_energy_kwh,unallocated_parts FROM ingest_gaps ORDER BY company_id')).rows,
      [{company_id:4,unallocated_energy_kwh:null,unallocated_parts:12},
        {company_id:5,unallocated_energy_kwh:9,unallocated_parts:13}]);
    await client.query(`INSERT INTO energy_meter_readings(company_id,machine_id,read_at,kwh_total,
      kw_total,i_avg,v_ll_avg,pf_avg,thd_i1,standalone_fields) VALUES
      (4,20,NOW(),681.4,-0.199,0,414.78,-0.697,0,ARRAY['kwh_total','kw_total','i_avg','v_ll_avg','pf_avg','thd_i1']),
      (4,21,NOW(),700,3.04e31,2.5e27,1.5e15,4,0,ARRAY['kwh_total','kw_total','i_avg','v_ll_avg','pf_avg','thd_i1'])`);
    const retained = (await client.query(`SELECT machine_id,kwh_total,kw_total,i_avg,v_ll_avg,pf_avg,thd_i1,standalone_fields
      FROM energy_meter_readings WHERE company_id=4 ORDER BY machine_id`)).rows;
    assert.deepEqual(retained, [
      { machine_id: 20, kwh_total: 681.4, kw_total: -0.199, i_avg: 0, v_ll_avg: 414.78, pf_avg: -0.697,
        thd_i1: 0, standalone_fields: ['kwh_total','kw_total','i_avg','v_ll_avg','pf_avg','thd_i1'] },
      { machine_id: 21, kwh_total: 700, kw_total: null, i_avg: null, v_ll_avg: null, pf_avg: null,
        thd_i1: 0, standalone_fields: ['kwh_total','thd_i1'] }
    ], 'invalid finite values must lose provenance, valid zero/signed power/energy must remain unchanged');
    const dropped = await client.query(`INSERT INTO energy_meter_readings(company_id,machine_id,read_at,v_ll_avg)
      VALUES(4,22,NOW(),'Infinity'),(4,23,NOW(),'NaN'),(4,24,NOW(),-1) RETURNING machine_id`);
    assert.equal(dropped.rowCount, 0, 'entirely invalid energy packets must not become empty latest readings');
    await client.query(`INSERT INTO telemetry_raw(company_id,machine_id,received_at,energy,voltage,current,power,parts_count)
      VALUES(4,25,NOW(),681.4,1.5e15,0,-0.199,39)`);
    assert.deepEqual((await client.query('SELECT energy,voltage,current,power,parts_count FROM telemetry_raw WHERE machine_id=25')).rows[0],
      { energy: 681.4, voltage: null, current: 0, power: -0.199, parts_count: 39 });
    await client.query(`DELETE FROM energy_meter_readings WHERE company_id=4 AND machine_id=20`);
    // The migration does not install the existing AFTER DELETE trigger in this minimal fixture;
    // verify its maintenance fast path directly through a fixture trigger.
    await client.query(`CREATE TRIGGER delete_v2 AFTER DELETE ON energy_meter_readings
      FOR EACH ROW EXECUTE FUNCTION energy_meter_deleted_v2()`);
    await client.query('BEGIN');
    await client.query("SET LOCAL iot.energy_retention_cleanup='on'");
    await client.query('DELETE FROM energy_meter_readings WHERE company_id=4 AND machine_id=21');
    await client.query('COMMIT');
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM queued')).rows[0].n, 0,
      'bulk maintenance must skip per-row reconciliation and invalidate once per device');
    const stripExists = (await client.query(`SELECT COUNT(*)::int AS n FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='energy_strip_payload'`, [schema])).rows[0].n;
    if (stripExists) {
      const payload = { machine: 'VMC19', time: 1795445087, parts_count: 37, power: 2, energy: { total: 3 },
        voltage: { V1N: 239 }, current: { I1: 0.5 }, active_power: { total: 2 },
        cnc: { spindle_speed: 0, position: { X: 12 }, energy: 9 } };
      const stripped = (await client.query('SELECT energy_strip_payload($1::jsonb) AS payload', [JSON.stringify(payload)])).rows[0].payload;
      assert.deepEqual(stripped, { machine: 'VMC19', time: 1795445087, parts_count: 37,
        cnc: { spindle_speed: 0, position: { X: 12 } } }, 'energy cleanup must preserve CNC payload keys recursively');
      await client.query(`INSERT INTO telemetry_late(company_id,machine_id,received_at,device_time,payload)
        VALUES(4,19,NOW(),EXTRACT(EPOCH FROM NOW()-INTERVAL '6 days'),$1::jsonb),
        (5,19,NOW(),EXTRACT(EPOCH FROM NOW()-INTERVAL '6 days'),$1::jsonb)`, [JSON.stringify(payload)]);
      const late = (await client.query('SELECT company_id,payload FROM telemetry_late ORDER BY company_id')).rows;
      assert.deepEqual(late, [{ company_id: 4, payload: stripped }, { company_id: 5, payload }],
        'late CNC records survive with only the opted-in old energy fields removed');
    }
    return { checks: 'passed', meter_channels: columns.length, payload_strip_checked: Boolean(stripExists) };
  } finally {
    if (created) {
      await client.query('ROLLBACK').catch(() => {});
      await client.query('SET search_path=pg_catalog');
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await client.end();
  }
}
if (require.main === module) verify(process.argv[2]).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verify };
