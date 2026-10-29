const assert = require('node:assert/strict');
const repo = require('node:path').resolve(__dirname, '../..');
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for this local SQL fixture');
const target = new URL(connectionString);
if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error('Use only a disposable local PostgreSQL database');
}
const { Client } = require(repo + '/node_modules/pg');
const pg = new Client({ connectionString });
let checked = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checked++; };
(async () => {
 await pg.connect();
 await pg.query('SET TIME ZONE \'UTC\'');
 await pg.query(`
 CREATE TEMP TABLE machines(id int primary key, company_id int, plant_id int, is_active boolean, machine_serial_no text, model text, hour_rate numeric);
 CREATE TEMP TABLE shifts(id int primary key, company_id int, plant_id int, is_active boolean, shift_code text, shift_name text, start_time time, end_time time);
 CREATE TEMP TABLE production_hourly(company_id int,machine_id int,shift_id int,hour_start timestamptz,run_seconds int,idle_seconds int,produced_qty int,energy_kwh numeric,manual_seconds int);
 CREATE TEMP TABLE machine_current_job(machine_id int,component_id int,is_active boolean,company_id int);
 CREATE TEMP TABLE components(id int,company_id int,cycle_time interval,multiplication_factor numeric);
 CREATE TEMP TABLE quality_entries(machine_id int,shift_id int,shift_date date,reject_qty int,rework_qty int);
 CREATE TEMP TABLE machine_alarms(company_id int,machine_id int,started_at timestamptz);
 CREATE TEMP TABLE downtime_events(company_id int,machine_id int,started_at timestamptz,ended_at timestamptz);
 CREATE TEMP TABLE telemetry_raw(company_id int,machine_id int,received_at timestamptz,machine_status text,alarm boolean);
 CREATE TEMP TABLE operators(id int,company_id int,operator_name text,is_active boolean);
 CREATE TEMP TABLE operator_machine_assignments(id int,machine_id int,operator_id int,is_active boolean);
 CREATE TEMP TABLE oee_hourly(company_id int,machine_id int,shift_id int,hour_start timestamptz,availability numeric,performance numeric,quality numeric,oee numeric);
 CREATE TEMP TABLE oee_shift_summary(machine_id int,shift_id int,shift_date date,availability numeric,performance numeric,quality numeric,oee numeric);
 INSERT INTO machines VALUES(1,4,2,true,'M1','Model',50),(2,5,3,true,'Foreign','Model',20),(3,4,2,false,'Inactive','Model',10),(4,4,3,true,'OtherPlant','Model',10);
 INSERT INTO shifts VALUES(1,4,null,true,'Shift 1','Shift 1','08:00','20:00'),(2,4,null,true,'Shift 2','Shift 2','20:00','08:00'),(3,4,null,true,'Half','Half','20:30','08:30'),(4,4,null,true,'Full','Full','08:00','08:00');
 INSERT INTO production_hourly VALUES
 (4,1,1,'2026-10-26 08:00+05:30',60,60,10,1,0),
 (4,1,2,'2026-10-26 20:00+05:30',60,60,20,1,0),
 (4,1,2,'2026-10-27 07:00+05:30',60,60,30,1,0),
 (4,1,2,'2026-10-26 07:00+05:30',60,60,900,1,0),
 (4,1,null,'2026-10-26 06:00+05:30',60,60,7,1,0),
 (5,1,1,'2026-10-26 10:00+05:30',60,60,1000,1,0),
 (5,2,1,'2026-10-26 10:00+05:30',60,60,2000,1,0),
 (4,3,1,'2026-10-26 10:00+05:30',60,60,3000,1,0),
 (4,4,1,'2026-10-26 10:00+05:30',60,60,4000,1,0),
 (4,1,1,NOW()+interval '3 days',60,60,5000,1,0);
 INSERT INTO quality_entries VALUES(1,1,'2026-10-26',1,0),(1,2,'2026-10-26',2,0);
 INSERT INTO telemetry_raw VALUES(4,1,NOW()-interval '10 minutes','RUNNING',false),(4,1,NOW()+interval '1 minute','RUNNING',false);
 INSERT INTO oee_hourly VALUES
 (NULL,1,NULL,'2026-10-26 06:00+05:30',10,20,30,40),
 (NULL,1,NULL,'2026-09-01 06:00+05:30',10,20,30,40),
 (5,1,1,'2026-10-26 10:00+05:30',10,20,30,40),
 (4,1,1,NOW()+interval '3 days',10,20,30,40),
 (4,1,2,'2026-10-27 07:00+05:30',10,20,30,40);
 INSERT INTO oee_shift_summary VALUES(1,1,'2026-10-26',10,20,30,40),(1,1,CURRENT_DATE+5,10,20,30,40);
 `);
 require.cache[require.resolve(repo+'/src/db')] = { exports: { query: (...args) => pg.query(...args) } };
 const scope = require(repo+'/src/lib/read-scope');
 const svc = require(repo+'/src/dashboard/oee.dashboard.service');
 const reports = require(repo+'/src/reports/report.service');
 const { shiftDateWindow, shiftStartDay } = require(repo+'/src/dashboard/production-window');
 const run = fn => scope.run({company_id:4,plant_id:2},fn);
 let data = await run(()=>svc.getOee({company_id:4,from:'2026-10-26',to:'2026-10-26',all_machines:'1'}));
 check(data.kpis.produced,67); check(data.trend.reduce((n,d)=>n+d.produced,0),67); check(data.machines.data.length,1); check(data.kpis.rejected,3);
 check(data.status_counts.OFFLINE,1);
 await pg.query("INSERT INTO quality_entries VALUES(1,1,'2026-10-27',50,0)");
 const qualityDay = await run(()=>svc.machineTotals({companyId:4,start:'2026-10-26T08:00:00+05:30',end:'2026-10-27T08:00:00+05:30',qualityDays:{from:'2026-10-26',to:'2026-10-26'}}));
 check(Number(qualityDay[0].rejected),3);
 data = await run(()=>svc.getOee({company_id:4,from:'2026-10-26',to:'2026-10-26',shift_id:2}));
 check(data.kpis.produced,50); check(data.trend[0].produced,50); check(data.kpis.rejected,2);
 const hourly = await run(()=>reports.oeeHourlyData(4,'2026-10-26','2026-10-26'));
 check(hourly.rows.map(r=>r.hour),['26-Oct 06:00','27-Oct 07:00']);
 const completed = await run(()=>reports.shiftOeeData(4,'2026-10-26','2026-12-01'));
 check(completed.rows.length,1);
 let bounded = await pg.query(`SELECT p.hour_start, ${shiftStartDay('p','s')} AS day FROM production_hourly p JOIN shifts s ON s.id=p.shift_id WHERE ${shiftDateWindow('p','s',{from:"'2026-10-28'::date",to:"'2026-10-28'::date",asOf:"'2026-10-28 20:15+05:30'::timestamptz"})}`);
 check(bounded.rows.length,0);
 await pg.query(`INSERT INTO production_hourly VALUES(4,1,3,'2026-10-28 20:00+05:30',60,60,5,1,0)`);
 bounded = await pg.query(`SELECT p.produced_qty FROM production_hourly p JOIN shifts s ON s.id=p.shift_id WHERE ${shiftDateWindow('p','s',{from:"'2026-10-28'::date",to:"'2026-10-28'::date",asOf:"'2026-10-28 20:15+05:30'::timestamptz"})}`);
 check(bounded.rows.length,0);
 bounded = await pg.query(`SELECT p.produced_qty, TO_CHAR(${shiftStartDay('p','s')},'YYYY-MM-DD') AS day FROM production_hourly p JOIN shifts s ON s.id=p.shift_id WHERE ${shiftDateWindow('p','s',{from:"'2026-10-28'::date",to:"'2026-10-28'::date",asOf:"'2026-10-28 20:45+05:30'::timestamptz"})}`);
 check(bounded.rows,[{produced_qty:5,day:'2026-10-28'}]);
 await pg.query(`INSERT INTO machines SELECT n,4,2,true,'M'||n,'Model',10 FROM generate_series(10,249)n`);
 data = await run(()=>svc.getOee({company_id:4,from:'2026-10-26',to:'2026-10-26',all_machines:true}));
 const exported = await run(()=>svc.getExportRows({company_id:4,from:'2026-10-26',to:'2026-10-26'}));
 check(data.machines.data.length,241); check(exported.length,241);
 check(exported.reduce((n,d)=>n+d.Production,0),67);
 console.log(`${checked} actual PostgreSQL assertions passed`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pg.end());
