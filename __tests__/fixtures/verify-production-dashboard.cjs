const assert = require('node:assert/strict');
// Opt-in SQL regression fixture. Uses session-local tables and never reads
// application credentials. Start a disposable local PostgreSQL instance.
const path = require('node:path').resolve(__dirname, '../..');
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for this local SQL fixture');
const testDatabase = new URL(connectionString);
if (!['postgres:', 'postgresql:'].includes(testDatabase.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(testDatabase.hostname)) {
  throw new Error('Production consistency fixtures require a disposable local PostgreSQL database');
}
const { Client } = require(path + '/node_modules/pg');
const dbPath = require.resolve(path + '/src/db');
const oeePath = require.resolve(path + '/src/dashboard/oee.dashboard.service');
let checks = 0;
function equal(a, b, msg) { assert.deepEqual(a, b, msg); checks++; }
const RealDate = Date;
let clock = RealDate.parse('2026-10-28T22:36:00+05:30');
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
const client = new Client({ connectionString });
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (...args) => client.query(...args) } };
require.cache[oeePath] = { id: oeePath, filename: oeePath, loaded: true, exports: {
  machineTotals: async () => [], deriveOee: row => row, fleetOee: () => ({}), DEFAULT_THRESHOLDS: {}
} };
const factory = require(path + '/src/dashboard/factory.service');
const charts = require(path + '/src/charts/charts.service');
const req = query => ({ user: { company_id: 4 }, query: { date: '2026-10-28', ...query } });
const run = query => factory.getFactoryDashboard(req(query));
const chart = (date = '2026-10-28', shiftId) => charts.getChartData({ companyId: 4, machineId: 7, shiftId, date });

(async () => {
  await client.connect();
  await client.query(`
    CREATE TEMP TABLE machines (id int, company_id int, plant_id int, is_active bool, machine_serial_no text, image_url text);
    CREATE TEMP TABLE shifts (id int, company_id int, plant_id int, shift_code text, shift_name text, start_time time, end_time time, is_active bool);
    CREATE TEMP TABLE company_settings (company_id int, energy_rate_per_kwh numeric, currency text, oee_target_percent numeric);
    CREATE TEMP TABLE energy_settings (company_id int, machine_id int, cost_per_kwh numeric, currency text);
    CREATE TEMP TABLE telemetry_raw (machine_id int, company_id int, machine_status text, alarm bool, received_at timestamptz, parts_count int, device_time bigint);
    CREATE TEMP TABLE production_hourly (company_id int, machine_id int, shift_id int, hour_start timestamptz, produced_qty int, run_seconds int, idle_seconds int, energy_kwh numeric);
    CREATE TEMP TABLE machine_current_job (machine_id int, company_id int, is_active bool, target_qty int);
    CREATE TEMP TABLE downtime_events (company_id int, machine_id int, shift_id int, started_at timestamptz, duration_seconds int, downtime_reason_id int);
    CREATE TEMP TABLE downtime_reasons (id int, name text, category text);
    CREATE TEMP TABLE machine_alarms (company_id int, machine_id int, shift_id int, started_at timestamptz, severity text, is_resolved bool);
    INSERT INTO company_settings VALUES(4,10,'INR',85);
    INSERT INTO machines VALUES (7,4,1,true,'M7',null),(9,4,1,true,'M9',null),(11,99,2,true,'FOREIGN',null);
    INSERT INTO shifts VALUES (1,4,1,'Shift1','Shift1','08:00','20:00',true),(2,4,1,'Shift2','Shift2','20:00','08:00',true),(99,99,2,'Foreign','Foreign','08:00','20:00',true);
    INSERT INTO machine_current_job VALUES (7,4,true,863),(9,99,true,50000);
    INSERT INTO production_hourly VALUES
      (4,7,1,'2026-10-28 08:00+05:30',433,3600,0,2),
      (4,7,2,'2026-10-28 20:00+05:30',60,3600,0,3),
      (4,9,2,'2026-10-28 20:00+05:30',5629,3600,0,4),
      (4,11,2,'2026-10-28 20:00+05:30',900000,3600,0,999),
      (99,7,2,'2026-10-28 20:00+05:30',9000,3600,0,999),
      (4,7,2,'2026-10-28 23:00+05:30',1000,3600,0,999),
      (4,7,2,'2026-10-28 02:00+05:30',4000,3600,0,1),
      (4,7,2,'2026-10-29 09:00+05:30',8000,3600,0,999),
      (4,7,1,'2026-10-27 08:00+05:30',17,3600,0,5);
  `);
  let out = await run();
  equal(out.production.produced, 6122, 'all recorded output');
  equal(out.production.actual, 493, 'target coverage uses only valid current company jobs');
  equal(out.production.target, 1726, 'foreign current job target excluded');
  equal(out.shiftwise.map(s => [s.produced,s.actual]), [[433,433],[5689,60]], 'screenshot discrepancy is explicit coverage, not rewritten data');
  equal(out.trend.reduce((sum,row) => sum+row.produced,0), 6122, 'trend total matches total output');
  equal(out.trend.reduce((sum,row) => sum+row.actual,0), 493, 'target comparison trend matches targeted shift counts');
  equal((await chart()).totalProduced, 493, 'one machine chart agrees with same factory filter');
  equal((await run({ machine_id:'7' })).production.produced, 493, 'machine filter same total');
  equal((await chart('2026-10-28',2)).totalProduced, 60, 'shift filter chart agrees');
  equal((await run({ shift_id:'2',machine_id:'7' })).production.produced, 60, 'shift filter factory agrees');
  equal((await run({ shift_id:'2',machine_id:'7' })).shiftwise.map(row => row.shift_id),[2],'selected shift returns only its comparison bar');
  equal(out.energy.month_kwh,15, 'MTD excludes future, foreign company and foreign owner');
  equal((await run({ date:'2026-10-27' })).energy.month_kwh,5,'historical month figure stops at selected day');
  await client.query(`UPDATE shifts SET start_time='08:30',end_time='20:30' WHERE id=1;
    UPDATE shifts SET start_time='20:30',end_time='08:30' WHERE id=2;`);
  out = await run({machine_id:'7'});
  equal(out.production.produced,493,'half-hour shift includes first overlapping hourly row');
  equal((await chart()).totalProduced,493,'half-hour chart uses same bucket overlap');
  clock=RealDate.parse('2026-10-28T20:15:00+05:30');
  out=await run({machine_id:'7'});
  equal(out.production.produced,433,'upcoming 20:30 shift excludes preloaded20:00 bucket');
  equal((await chart()).totalProduced,433,'chart upcoming shift matches factory');
  equal((await chart('2026-10-28',2)).totalProduced,0,'explicit upcoming shift remains empty');
  clock=RealDate.parse('2026-10-29T02:00:00+05:30');
  equal((await run({machine_id:'7'})).production.produced,1493,'overnight today includes elapsed23:00 bucket');
  equal((await chart()).totalProduced,1493,'overnight chart agrees');
  clock=RealDate.parse('2026-10-28T22:36:00+05:30');
  await client.query(`DELETE FROM shifts WHERE id=2; UPDATE shifts SET start_time='08:00',end_time='08:00' WHERE id=1;
    DELETE FROM production_hourly; INSERT INTO production_hourly VALUES (4,7,1,'2026-10-28 08:00+05:30',12,600,0,1),(4,7,1,'2026-10-29 07:00+05:30',8,600,0,1);`);
  equal((await run({shift_id:'1',machine_id:'7'})).production.produced,12,'24hour window is not empty and excludes future');
  equal((await chart('2026-10-28',1)).totalProduced,12,'24hour chart agrees');
  await client.query(`INSERT INTO telemetry_raw(machine_id,company_id,received_at,parts_count,device_time,machine_status) VALUES
    (7,4,'2026-10-28 08:00:00+05:30',100,1000,'RUNNING'),
    (7,4,'2026-10-28 08:00:01+05:30',101,1001,'RUNNING'),
    (7,4,'2026-10-28 08:00:02+05:30',5689,1002,'RUNNING'),
    (7,4,'2026-10-28 08:00:03+05:30',5690,1003,'RUNNING'),
    (7,4,'2026-10-28 08:10:03+05:30',5691,1603,'RUNNING');`);
  const timing=await charts.getPartTiming({companyId:4,machineId:7,shiftStartEpoch:RealDate.parse('2026-10-28T08:00:00+05:30')/1000,shiftEndEpoch:RealDate.parse('2026-10-28T08:11:00+05:30')/1000});
  equal(timing.parts.length,2,'huge counter baseline jump and long gap cannot fabricate perpart rows');
  await client.query('DELETE FROM telemetry_raw');
  const timingInput = [11,5,11,5,11,12];
  for (const [second, count] of timingInput.entries()) await client.query(`INSERT INTO telemetry_raw
    (machine_id,company_id,received_at,parts_count,device_time,machine_status)
    VALUES(7,4,$1,$2,$3,'RUNNING')`,[new RealDate(RealDate.parse('2026-10-28T08:00:00+05:30')+second*1000),count,1000+second]);
  const oscillation = await charts.getPartTiming({companyId:4,machineId:7,
    shiftStartEpoch:RealDate.parse('2026-10-28T08:00:00+05:30')/1000,
    shiftEndEpoch:RealDate.parse('2026-10-28T08:11:00+05:30')/1000});
  equal(oscillation.parts.length,1,'repeated counter rebounds only count the new high12 once');
  console.log(`${checks} actual PostgreSQL production consistency assertions passed`);
})().finally(()=>client.end()).catch(error=>{console.error(error);process.exitCode=1;});
