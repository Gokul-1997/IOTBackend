#!/usr/bin/env node
'use strict';
// Explicit disposable test connection only. Every fixture, role, event trigger
// and migration change is inside one transaction that is always rolled back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { partsOf } = require('./migrate');

const migration = partsOf(fs.readFileSync(path.join(__dirname, '../src/migrations/066_energy_meter_thd.sql'), 'utf8')).body;
const columns = ['thd_v1n', 'thd_v2n', 'thd_v3n', 'thd_v12', 'thd_v23', 'thd_v31', 'thd_i1', 'thd_i2', 'thd_i3'];

async function verify(client) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const schema = `thd_verify_${suffix}`;
  const owner = `thd_owner_${suffix}`;
  const event = `thd_legacy_grant_${suffix}`;
  const checks = [];
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path = ${schema}, public`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='machine_api_user') THEN
        CREATE ROLE machine_api_user NOLOGIN;
      END IF;
    END $$;
    CREATE ROLE ${owner} NOLOGIN;
    GRANT USAGE, CREATE ON SCHEMA ${schema} TO machine_api_user, ${owner}`);
    const { rows: [extension] } = await client.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'");
    const before = (await client.query("SELECT current_setting('timescaledb.restoring', true) AS value")).rows[0].value;

    for (const compressed of extension ? [false, true] : [false]) {
      await client.query(`DROP TABLE IF EXISTS ${schema}.energy_meter_readings CASCADE;
        CREATE TABLE ${schema}.energy_meter_readings(machine_id INT, company_id INT, read_at TIMESTAMPTZ NOT NULL,
          kw_total REAL, PRIMARY KEY(machine_id,read_at));
        GRANT SELECT, INSERT ON energy_meter_readings TO machine_api_user`);
      if (compressed) {
        await client.query(`SELECT create_hypertable('energy_meter_readings','read_at');
          ALTER TABLE energy_meter_readings SET(timescaledb.compress,
            timescaledb.compress_segmentby='company_id,machine_id',timescaledb.compress_orderby='read_at DESC')`);
      }
      await client.query("INSERT INTO energy_meter_readings VALUES(1,4,'2026-08-01T12:00:00Z',3)");
      if (compressed) {
        await client.query("SELECT compress_chunk(show_chunks('energy_meter_readings'))");
        assert.equal((await client.query(`SELECT COUNT(*)::int n FROM timescaledb_information.chunks
          WHERE hypertable_schema=$1 AND hypertable_name='energy_meter_readings' AND is_compressed`, [schema])).rows[0].n, 1);
      }
      await client.query(migration);
      await client.query(migration);
      const { rows: fields } = await client.query(`SELECT a.attname,has_column_privilege('machine_api_user',a.attrelid,a.attname,'UPDATE') AS allowed
        FROM pg_attribute a WHERE a.attrelid='energy_meter_readings'::regclass AND a.attname=ANY($1::text[])`, [columns]);
      assert.equal(fields.length, 9);
      assert(fields.every(field => field.allowed));
      assert.equal((await client.query("SELECT current_setting('timescaledb.restoring',true) AS value")).rows[0].value, before);
      await client.query(`SET LOCAL ROLE machine_api_user;
        INSERT INTO energy_meter_readings(machine_id,company_id,read_at,thd_v1n)
          VALUES(2,4,'2026-11-23T12:00:00Z',0)
          ON CONFLICT(machine_id,read_at) DO UPDATE SET thd_v1n=EXCLUDED.thd_v1n;
        INSERT INTO energy_meter_readings(machine_id,company_id,read_at,thd_v1n)
          VALUES(2,4,'2026-11-23T12:00:00Z',2.5)
          ON CONFLICT(machine_id,read_at) DO UPDATE SET thd_v1n=EXCLUDED.thd_v1n;
        UPDATE energy_meter_readings SET thd_v1n=1.5 WHERE machine_id=1`);
      const { rows } = await client.query('SELECT machine_id,kw_total,thd_v1n,thd_i3 FROM energy_meter_readings ORDER BY machine_id');
      assert.deepEqual(rows, [{ machine_id: 1, kw_total: 3, thd_v1n: 1.5, thd_i3: null },
        { machine_id: 2, kw_total: null, thd_v1n: 2.5, thd_i3: null }]);
      await client.query('SAVEPOINT denied_identity_update');
      await assert.rejects(client.query('UPDATE energy_meter_readings SET machine_id=4 WHERE machine_id=1'), { code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT denied_identity_update; RESET ROLE');
      checks.push({ check: compressed ? 'actual_compressed_hypertable' : 'plain_table',
        idempotent: true, ingestion_upsert: true, historical_values_preserved: true, identity_update_denied: true });
    }

    if (extension) {
      // Remove all THD UPDATE rights first, so the fallback must install real
      // permissions rather than succeeding against previously granted ACLs.
      await client.query("SELECT set_config('timescaledb.restoring','on',true)");
      await client.query(`REVOKE UPDATE(${columns.join(',')}) ON ${schema}.energy_meter_readings FROM machine_api_user`);
      await client.query("SELECT set_config('timescaledb.restoring',$1,true)", [before]);
      assert((await client.query(`SELECT has_column_privilege('machine_api_user','${schema}.energy_meter_readings',field,'UPDATE') AS allowed
        FROM unnest($1::text[]) field`, [columns])).rows.every(row => !row.allowed));
      // Modern Timescale versions fix the old forwarding bug. This explicitly
      // labeled event trigger recreates its undefined_column failure so the
      // exceptional branch remains exercised alongside real compressed data.
      await client.query(`CREATE FUNCTION ${schema}.legacy_grant_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('iot.verify_legacy_grant',true)='on'
            AND current_setting('timescaledb.restoring')<>'on' THEN
            RAISE EXCEPTION USING ERRCODE='42703',
              MESSAGE='column "thd_v1n" of relation "_compressed_hypertable_emulated" does not exist';
          END IF;
        END $$;
        CREATE EVENT TRIGGER ${event} ON ddl_command_start WHEN TAG IN ('GRANT')
          EXECUTE FUNCTION ${schema}.legacy_grant_failure();
        SET LOCAL iot.verify_legacy_grant='on';
        SAVEPOINT legacy_probe`);
      await assert.rejects(client.query('GRANT UPDATE(thd_v1n) ON energy_meter_readings TO machine_api_user'), { code: '42703' });
      await client.query('ROLLBACK TO SAVEPOINT legacy_probe');
      await client.query(migration);
      assert.equal((await client.query("SELECT current_setting('timescaledb.restoring') AS value")).rows[0].value, before);
      const { rows: granted } = await client.query(`SELECT has_column_privilege('machine_api_user','${schema}.energy_meter_readings',field,'UPDATE') AS allowed
        FROM unnest($1::text[]) field`, [columns]);
      assert.equal(granted.length, 9);
      assert(granted.every(row => row.allowed));
      await client.query(`SET LOCAL ROLE machine_api_user;
        INSERT INTO energy_meter_readings(machine_id,company_id,read_at,thd_i1)
          VALUES(2,4,'2026-11-23T12:00:00Z',0)
          ON CONFLICT(machine_id,read_at) DO UPDATE SET thd_i1=EXCLUDED.thd_i1;
        RESET ROLE`);
      assert.equal((await client.query('SELECT thd_i1 FROM energy_meter_readings WHERE machine_id=2')).rows[0].thd_i1, 0);
      await client.query('SELECT set_config(\'timescaledb.restoring\',\'on\',true)');
      await client.query(migration);
      assert.equal((await client.query("SELECT current_setting('timescaledb.restoring') AS value")).rows[0].value, 'on');
      await client.query("SELECT set_config('timescaledb.restoring',$1,true)", [before]);
      checks.push({ check: 'emulated_legacy_column_grant_failure', passed: true, setting_restored: true,
        installs_missing_grants: true, ingestion_upsert: true });

      // The fallback must fail clearly and roll back its schema changes when
      // the migration owner cannot SET the superuser-only Timescale setting.
      await client.query('SET LOCAL iot.verify_legacy_grant=\'off\'');
      await client.query(`DROP TABLE ${schema}.energy_meter_readings CASCADE;
        CREATE TABLE ${schema}.energy_meter_readings(machine_id INT,company_id INT,read_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY(machine_id,read_at));
        ALTER TABLE energy_meter_readings OWNER TO ${owner};
        SET LOCAL iot.verify_legacy_grant='on';
        SAVEPOINT non_superuser_migration;
        SET LOCAL ROLE ${owner}`);
      await assert.rejects(client.query(migration), error => error.code === '42501' && /administrator permission/.test(error.message));
      await client.query('ROLLBACK TO SAVEPOINT non_superuser_migration; RESET ROLE');
      assert.equal((await client.query(`SELECT COUNT(*)::int n FROM pg_attribute
        WHERE attrelid='energy_meter_readings'::regclass AND attname=ANY($1::text[])`, [columns])).rows[0].n, 0);
      assert.equal((await client.query("SELECT current_setting('timescaledb.restoring') AS value")).rows[0].value, before);
      checks.push({ check: 'legacy_fallback_requires_parameter_privilege_and_rolls_back', passed: true });
    }
    return { timescaledb: extension?.extversion || null, checks, rolled_back: true };
  } finally {
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present', [schema])).rows[0].present, false);
  }
}

module.exports = { verify };
if (require.main === module) {
  if (!process.env.ENERGY_TEST_DATABASE_URL) {
    console.error('Set ENERGY_TEST_DATABASE_URL explicitly to a disposable administrator test database');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.ENERGY_TEST_DATABASE_URL,
    application_name: 'energy-thd-isolated-verifier', statement_timeout: 60000 });
  client.connect().then(() => verify(client)).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => client.end());
}
