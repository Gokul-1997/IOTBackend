/* Run directly with Node. Uses only a disposable Unix-socket PostgreSQL;
 * never loads .env or connects to an existing service. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const repo = path.resolve(__dirname, '../..');
const pgBin = process.env.OPERATOR_FIXTURE_PG_BIN || '/opt/homebrew/opt/postgresql@18/bin';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-report-fixture-'));
let started = false;
let pool;
let asOf = '2026-10-28T20:15:00+05:30';
let assertions = 0;
const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
const params = { company_id: 4, from_date: '2026-10-28', to_date: '2026-10-28' };

(async () => {
  try {
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(temp, 'data'), '-U', 'operator_fixture', '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-l', path.join(temp, 'postgres.log'),
      '-o', `-F -k ${temp} -p 55449 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    pool = new Pool({ host: temp, port: 55449, user: 'operator_fixture', database: 'postgres' });
    const dbPath = require.resolve(path.join(repo, 'src/db'));
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
      query: (text, values) => pool.query(text, [...values.slice(0, 3), asOf, ...values.slice(4)])
    } };
    const { getOperatorPerformance } = require(path.join(repo, 'src/reports/operator.report.service'));
    const { run } = require(path.join(repo, 'src/lib/read-scope'));
    await pool.query(`
      CREATE TABLE operators(id INT, company_id INT, operator_name TEXT, operator_code TEXT);
      CREATE TABLE machines(id INT, company_id INT, plant_id INT);
      CREATE TABLE shifts(id INT, company_id INT, plant_id INT, start_time TIME, end_time TIME);
      CREATE TABLE operator_machine_assignments(operator_id INT, machine_id INT, company_id INT, is_active BOOLEAN);
      CREATE TABLE operator_shift_assignments(operator_id INT, shift_id INT, company_id INT, is_active BOOLEAN);
      CREATE TABLE production_hourly(company_id INT, machine_id INT, shift_id INT, hour_start TIMESTAMPTZ,
        produced_qty INT, run_seconds INT, idle_seconds INT);
      CREATE TABLE quality_entries(machine_id INT, shift_id INT, shift_date DATE, created_at TIMESTAMPTZ, reject_qty INT);
      INSERT INTO operators VALUES(1,4,'Own operator','OWN'),(2,4,'Other plant','OTHER'),(3,5,'Foreign','FOREIGN'),(4,4,'Unassigned','NONE');
      INSERT INTO machines VALUES(7,4,8),(8,4,10),(9,5,9);
      INSERT INTO shifts VALUES(1,4,NULL,'08:00','20:00'),(2,4,NULL,'20:00','08:00'),(3,4,NULL,'20:30','08:30'),(4,5,NULL,'08:00','20:00');
      INSERT INTO operator_machine_assignments VALUES
        (1,7,4,TRUE),(1,7,4,TRUE),(2,8,4,TRUE),(3,9,5,TRUE),
        (1,9,4,TRUE),(1,8,5,TRUE);
      INSERT INTO operator_shift_assignments VALUES
        (1,1,4,TRUE),(1,1,4,TRUE),(1,2,4,TRUE),(1,3,4,TRUE),
        (1,4,4,TRUE),(2,1,4,TRUE),(3,4,5,TRUE);
      INSERT INTO production_hourly VALUES
        (4,7,1,'2026-10-28 08:00+05:30',10,600,300),
        (4,7,1,'2026-10-28 19:00+05:30',20,1200,600),
        (5,7,1,'2026-10-28 09:00+05:30',9000,1000,500),
        (4,7,1,'2026-10-29 09:00+05:30',8000,1000,500),
        (4,7,2,'2026-10-27 23:00+05:30',500,1000,500),
        (4,7,2,'2026-10-28 20:00+05:30',7,600,300),
        (4,7,2,'2026-10-29 01:00+05:30',11,1000,500),
        (4,7,3,'2026-10-28 20:00+05:30',999,1000,500),
        (4,7,3,'2026-10-29 08:00+05:30',3,600,300),
        (4,8,1,'2026-10-28 08:00+05:30',300,1000,500),
        (5,9,4,'2026-10-28 08:00+05:30',400,1000,500);
      INSERT INTO quality_entries VALUES
        (7,1,'2026-10-28','2026-10-28 10:00+05:30',1),
        (7,1,'2026-10-28','2026-10-28 19:00+05:30',2),
        (7,1,NULL,'2026-10-28 18:00+05:30',4),
        (7,1,'2026-10-27','2026-10-27 19:00+05:30',90),
        (7,1,'2026-10-29','2026-10-29 19:00+05:30',80),
        (7,2,'2026-10-28','2026-10-28 20:10+05:30',2),
        (7,3,'2026-10-28','2026-10-28 20:35+05:30',5),
        (8,1,'2026-10-28','2026-10-28 19:00+05:30',30),
        (9,4,'2026-10-28','2026-10-28 19:00+05:30',40);
    `);

    const first = (await getOperatorPerformance({ ...params, shift_id: 1 })).data.find(row => row.operator_id === 1);
    equal(first.total_produced, '30');
    equal(first.total_run_seconds, '1800');
    equal(first.total_idle_seconds, '900');
    equal(first.total_rejected, '7');
    equal(first.machines_operated, '1');
    equal(first.quality_rate, '76.67');
    equal(first.utilization_rate, '66.67');
    equal(Object.keys(first).sort(), ['operator_id','operator_name','operator_code','machines_operated','total_produced',
      'total_run_seconds','total_idle_seconds','total_rejected','quality_rate','utilization_rate'].sort());

    const all = (await getOperatorPerformance(params)).data;
    equal(all.find(row => row.operator_id === 1).total_produced, '37');
    equal(all.find(row => row.operator_id === 1).total_rejected, '9');
    equal(all.some(row => row.operator_id === 3), false);
    equal(all.find(row => row.operator_id === 4).total_produced, '0');
    const scoped = await run({ company_id: 4, plant_id: 8, user_type: 'company_user' }, () => getOperatorPerformance(params));
    equal(scoped.data.map(row => row.operator_id), [1]);
    equal(scoped.data[0].total_produced, '37');

    // Another reject record must change rejects only, never duplicate hours.
    await pool.query("INSERT INTO quality_entries VALUES(7,1,'2026-10-28','2026-10-28 19:00+05:30',3)");
    const extra = (await getOperatorPerformance({ ...params, shift_id: 1 })).data.find(row => row.operator_id === 1);
    equal(extra.total_produced, '30');
    equal(extra.total_run_seconds, '1800');
    equal(extra.total_rejected, '10');

    asOf = '2026-10-29T09:00:00+05:30';
    const overnight = (await getOperatorPerformance({ ...params, shift_id: 2 })).data.find(row => row.operator_id === 1);
    equal(overnight.total_produced, '18');
    equal(overnight.total_rejected, '2');
    const partial = (await getOperatorPerformance({ ...params, shift_id: 3 })).data.find(row => row.operator_id === 1);
    equal(partial.total_produced, '1002');
    equal(partial.total_rejected, '5');
    const future = (await getOperatorPerformance({ ...params, from_date: '2026-10-30', to_date: '2026-10-30' })).data;
    equal(future.every(row => Number(row.total_produced) === 0 && Number(row.total_rejected) === 0), true);

    await pool.query("INSERT INTO quality_entries VALUES(7,1,'2026-10-28','2026-10-28 19:00+05:30',100)");
    const badQuality = (await getOperatorPerformance({ ...params, shift_id: 1 })).data.find(row => row.operator_id === 1);
    equal(badQuality.total_rejected, '110');
    equal(badQuality.total_produced, '30');
    equal(badQuality.quality_rate, '0.00');
    console.log(`Operator report PostgreSQL regression: ${assertions} assertions passed.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool?.end();
    if (started) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
