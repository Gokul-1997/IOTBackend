#!/usr/bin/env node
/* No .env is loaded. A disposable PostgreSQL cluster listens only on its
 * temporary Unix socket. Operational data/services are never contacted. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const repository = path.resolve(__dirname, '../..');
const pgBin = process.env.PMS_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-pms-fixture-'));
let running = false;
let pool;
const migration = fs.readFileSync(path.join(repository, 'src/migrations/042_pms_integrity.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(repository, 'src/migrations/rollback/042_pms_integrity_down.sql'), 'utf8');
const sql = `
CREATE TABLE companies(id INT PRIMARY KEY, is_active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE plans(id INT PRIMARY KEY, max_machines INT);
CREATE TABLE company_plans(company_id INT, plan_id INT, max_machines INT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE plants(id INT PRIMARY KEY, company_id INT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE line(id SERIAL PRIMARY KEY, plant_id INT, company_id INT, name TEXT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE machines(id SERIAL PRIMARY KEY, plant_id INT, company_id INT, line_id INT, machine_serial_no TEXT,
  x_axis TEXT, y_axis TEXT, z_axis TEXT, fourth_axis TEXT, fifth_axis TEXT, twin_spindle TEXT, twin_table TEXT,
  atc_tool_capacity TEXT, model TEXT, mmc_no TEXT, controller TEXT, spindle_rpm TEXT, image_url TEXT,
  hour_rate NUMERIC, api_key TEXT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE shifts(id INT PRIMARY KEY, plant_id INT, company_id INT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE machine_shift_config(plant_id INT, machine_id INT, shift_id INT);
CREATE TABLE components(id SERIAL PRIMARY KEY, plant_id INT, company_id INT, machine_id INT,
  part_name TEXT, part_number TEXT, operation_number TEXT, cycle_time INTERVAL, target INT, multiplication_factor INT);
CREATE TABLE machine_current_job(id SERIAL PRIMARY KEY, plant_id INT, company_id INT, machine_id INT,
  component_id INT, part_name TEXT, target_qty INT, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  setting_time_end TIMESTAMPTZ, is_active BOOLEAN DEFAULT TRUE);
CREATE TYPE ticket_status AS ENUM('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED');
CREATE TYPE ticket_priority AS ENUM('LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE ticket_issue_type AS ENUM('BREAKDOWN','ALARM','INSPECTION','OTHER');
CREATE TYPE maintenance_type AS ENUM('PREVENTIVE','CORRECTIVE','PREDICTIVE','INSPECTION');
CREATE TYPE maintenance_status AS ENUM('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED','OVERDUE');
CREATE TYPE maintenance_frequency AS ENUM('DAILY','WEEKLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY');
CREATE TABLE users(id INT PRIMARY KEY, company_id INT, plant_id INT, username TEXT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE machine_alarms(id INT PRIMARY KEY, company_id INT, machine_id INT, alarm_type TEXT, severity TEXT, message TEXT);
CREATE TABLE maintenance_tickets(id SERIAL PRIMARY KEY, company_id INT, machine_id INT, threshold_id INT, status ticket_status,
  title TEXT, description TEXT, issue_type ticket_issue_type, priority ticket_priority, assigned_to INT, created_by INT, alarm_id INT,
  parts_used TEXT, downtime_minutes INT, resolved_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE ticket_status_history(id SERIAL PRIMARY KEY, ticket_id INT, from_status ticket_status, to_status ticket_status,
  note TEXT, changed_by INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE maintenance_schedules(id SERIAL PRIMARY KEY, company_id INT, machine_id INT, title TEXT, description TEXT,
  maintenance_type maintenance_type, scheduled_at TIMESTAMPTZ, estimated_duration_minutes INT, assigned_to TEXT,
  status maintenance_status DEFAULT 'SCHEDULED', recurrence TEXT, created_by INT, frequency maintenance_frequency,
  next_due_at TIMESTAMPTZ, is_active BOOLEAN DEFAULT TRUE, updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE maintenance_logs(id SERIAL PRIMARY KEY, company_id INT, machine_id INT, maintenance_schedule_id INT, title TEXT,
  maintenance_type maintenance_type, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, duration_minutes INT,
  technician_name TEXT, work_performed TEXT, parts_replaced TEXT, cost NUMERIC, status maintenance_status, logged_by INT,
  created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE downtime_reasons(id INT PRIMARY KEY, company_id INT, code TEXT, name TEXT, category TEXT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE downtime_events(id SERIAL PRIMARY KEY, company_id INT, machine_id INT, shift_id INT, downtime_reason_id INT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, notes TEXT, entered_by INT,
  duration_seconds INT GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (ended_at-started_at))::INT) STORED);
INSERT INTO companies VALUES (4),(5),(8);
INSERT INTO plants VALUES (8,4),(9,5),(10,4),(18,8);
INSERT INTO line(id,plant_id,company_id,name) VALUES (8,8,4,'Own line'),(9,9,5,'Foreign line'),(10,10,4,'Other plant'),(99,9,4,'Legacy mismatch');
INSERT INTO machines(id,plant_id,company_id,line_id,machine_serial_no) VALUES (7,8,4,8,'VMC-7'),(9,9,5,9,'VMC-9'),(10,10,4,10,'Other plant'),(99,9,4,99,'Legacy mismatch'),(100,NULL,4,NULL,'Unplaced');
INSERT INTO users VALUES(1,4,8,'Own technician'),(2,4,10,'Other plant technician'),(3,4,NULL,'Company technician');
INSERT INTO machine_alarms VALUES(1,4,7,'AXIS','HIGH','Own alarm'),(2,4,10,'AXIS','HIGH','Other alarm');
INSERT INTO shifts VALUES(1,8,4),(2,18,8);
INSERT INTO components(id,plant_id,company_id,machine_id,part_name,part_number,cycle_time,target,multiplication_factor)
  VALUES(3,8,4,7,'Old part','PN-1','00:02:00',50,1);
INSERT INTO machine_current_job(plant_id,company_id,machine_id,component_id,part_name,target_qty,started_at,is_active)
  VALUES(8,4,7,3,'Old historical part',50,'2026-10-01T00:00:00Z',FALSE);
SELECT setval('line_id_seq',99),setval('machines_id_seq',100),setval('components_id_seq',3);`;

async function rejected(statement, code) {
  await assert.rejects(() => pool.query(statement), error => error.code === code);
}

(async () => {
  try {
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(directory, 'data'), '-U', 'cnc_fixture', '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-o', `-F -k ${directory} -p 55442 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    pool = new Pool({ host: directory, port: 55442, user: 'cnc_fixture', database: 'postgres', max: 4 });
    await pool.query(sql);
    await pool.query(migration);
    await pool.query(migration);
    assert.equal((await pool.query('SELECT cycle_time_seconds FROM machine_current_job WHERE id=1')).rows[0].cycle_time_seconds, null, 'No invented historical cycle backfill');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM line WHERE id=99')).rows[0].n, 1, 'Legacy placement preserved');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname LIKE 'fk_%_pms' AND NOT convalidated")).rows[0].n, 3);
    await rejected("INSERT INTO line(plant_id,company_id,name) VALUES(9,4,'Wrong tenant')", '23503');
    await rejected("INSERT INTO machines(plant_id,company_id,line_id,machine_serial_no) VALUES(8,4,9,'Wrong line')", '23503');
    await pool.query("INSERT INTO machine_current_job(machine_id,company_id,started_at) VALUES(7,4,NOW())");
    await rejected("INSERT INTO machine_current_job(machine_id,company_id,started_at) VALUES(7,4,NOW())", '23505');
    await pool.query('DELETE FROM machine_current_job WHERE is_active=TRUE');
    await pool.query("INSERT INTO maintenance_tickets(company_id,machine_id,threshold_id,status) VALUES(4,7,5,'OPEN')");
    await rejected("INSERT INTO maintenance_tickets(company_id,machine_id,threshold_id,status) VALUES(4,7,5,'ASSIGNED')", '23505');
    await pool.query("UPDATE maintenance_tickets SET status='CLOSED'");
    await pool.query("INSERT INTO maintenance_tickets(company_id,machine_id,threshold_id,status) VALUES(4,7,5,'OPEN')");

    // Service modules use this fixture pool; src/db.js and .env never load.
    const dbPath = require.resolve(path.join(repository, 'src/db.js'));
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
    const jobs = require(path.join(repository, 'src/job/job.service'));
    const components = require(path.join(repository, 'src/component/component.service'));
    const machines = require(path.join(repository, 'src/machines/machine.service'));
    const lines = require(path.join(repository, 'src/line/line.service'));
    const maintenance = require(path.join(repository, 'src/maintenance/maintenance.service'));
    const tickets = require(path.join(repository, 'src/tickets/ticket.service'));
    const downtime = require(path.join(repository, 'src/downtime/downtime.service'));
    const plantGuard = require(path.join(repository, 'src/middleware/plant-scope.middleware'));
    const scopedUser = { company_id: 4, plant_id: 8, roles: ['MAINTENANCE'] };
    async function guard(options, body = {}, query = {}, params = {}) {
      const req = { user: scopedUser, body, query, params };
      let forwarded;
      await plantGuard(options)(req, {}, error => { forwarded = error; });
      return { req, error: forwarded };
    }
    assert.equal((await guard({}, { machine_id: 7 })).error, undefined);
    assert.equal((await guard({}, { machine_id: 10 })).error.status, 404);
    assert.equal((await guard({}, { machine_id: 100 })).error.status, 404, 'Unplaced machine fails closed');
    assert.equal((await guard({ assignee: true }, { assigned_to: 2 })).error.status, 404);
    assert.equal((await guard({ assignee: true }, { assigned_to: 3 })).error, undefined, 'Company-wide technician allowed');
    assert.equal((await guard({}, { alarm_id: 2 })).error.status, 404);
    const ownSchedule = await maintenance.createSchedule({ company_id: 4, plant_id: 8, machine_id: 7, title: 'Own maintenance', scheduled_at: new Date(), recurrence: 'WEEKLY' });
    await maintenance.createSchedule({ company_id: 4, machine_id: 10, title: 'Other plant maintenance', scheduled_at: new Date() });
    await maintenance.createSchedule({ company_id: 4, machine_id: 100, title: 'Unplaced maintenance', scheduled_at: new Date() });
    const scopedSchedules = await maintenance.getSchedules({ company_id: 4, plant_id: 8 });
    assert.equal(scopedSchedules.pagination.total, 1);
    assert.deepEqual(scopedSchedules.data.map(row => row.id), [ownSchedule.id]);
    assert.equal((await maintenance.getSchedules({ company_id: 4 })).pagination.total, 3, 'Company admin sees company-wide schedules');
    await assert.rejects(() => maintenance.createSchedule({ company_id: 4, plant_id: 8, machine_id: 10, title: 'Forbidden', scheduled_at: new Date() }), error => error.status === 404);
    assert.equal((await guard({ resource: 'schedule' }, {}, {}, { id: ownSchedule.id + 1 })).error.status, 404);
    await assert.rejects(() => maintenance.updateSchedule(ownSchedule.id + 1, 4, { title: 'Forbidden edit' }, 8), error => error.status === 404);
    await assert.rejects(() => maintenance.deleteSchedule(ownSchedule.id + 1, 4, 8), error => error.status === 404);
    const ownLog = await maintenance.createLog({ company_id: 4, plant_id: 8, machine_id: 7, title: 'Own repair', started_at: '2026-10-13T00:00:00Z', completed_at: '2026-10-13T00:30:00Z' });
    await maintenance.createLog({ company_id: 4, machine_id: 10, title: 'Other repair', started_at: '2026-10-13T00:00:00Z', completed_at: '2026-10-13T01:00:00Z' });
    assert.deepEqual((await maintenance.getLogs({ company_id: 4, plant_id: 8 })).data.map(row => row.id), [ownLog.id]);
    assert.equal((await maintenance.getMTTR({ company_id: 4, plant_id: 8 }))[0].avg_repair_minutes, '30.0000000000000000');
    const ownTicket = await tickets.createTicket({ company_id: 4, plant_id: 8, machine_id: 7, title: 'Own ticket', assigned_to: 1 });
    const otherTicket = await tickets.createTicket({ company_id: 4, machine_id: 10, title: 'Other ticket' });
    await tickets.createTicket({ company_id: 4, machine_id: 100, title: 'Unplaced ticket' });
    assert.equal((await tickets.getTickets({ company_id: 4, plant_id: 8 })).pagination.total, 3); // Two existing PM rows plus the own ticket.
    assert.deepEqual((await tickets.getAssignees(4, 8)).map(row => row.id).sort(), [1, 3]);
    assert.equal((await guard({ resource: 'ticket' }, {}, {}, { id: otherTicket.id })).error.status, 404);
    await assert.rejects(() => tickets.getTicketById(otherTicket.id, 4, 8), error => error.status === 404);
    await assert.rejects(() => tickets.updateTicket(otherTicket.id, 4, { title: 'Forbidden' }, 8), error => error.status === 404);
    await assert.rejects(() => tickets.updateTicketStatus(otherTicket.id, 4, { status: 'RESOLVED', plant_id: 8 }), error => error.status === 404);
    await assert.rejects(() => tickets.assignTicket(otherTicket.id, 4, { assigned_to: 1, plant_id: 8 }), error => error.status === 404);
    await assert.rejects(() => tickets.createTicket({ company_id: 4, plant_id: 8, machine_id: 10, title: 'Forbidden' }), error => error.status === 404);
    await tickets.updateTicketStatus(ownTicket.id, 4, { status: 'IN_PROGRESS', plant_id: 8 });
    await assert.rejects(() => tickets.assignTicket(ownTicket.id, 4, { assigned_to: 2, plant_id: 8 }), error => error.status === 404);
    await tickets.assignTicket(ownTicket.id, 4, { assigned_to: 3, plant_id: 8 });
    assert.equal((await tickets.getSummary(4, 8)).reduce((n, row) => n + row.count, 0), 2);
    const ownEvent = await downtime.logEvent({ company_id: 4, plant_id: 8, machine_id: 7, started_at: '2026-10-13T00:00:00Z', ended_at: '2026-10-13T00:30:00Z' });
    await downtime.logEvent({ company_id: 4, machine_id: 10, started_at: '2026-10-13T00:00:00Z', ended_at: '2026-10-13T01:00:00Z' });
    assert.deepEqual((await downtime.getEvents({ company_id: 4, plant_id: 8 })).data.map(row => row.id), [ownEvent.id]);
    assert.equal(Number((await downtime.getDowntimeSummary({ company_id: 4, plant_id: 8, from_date: '2026-10-12', to_date: '2026-10-14' }))[0].total_seconds), 1800);
    await assert.rejects(() => downtime.logEvent({ company_id: 4, plant_id: 8, machine_id: 10 }), error => error.status === 404);
    await pool.query('DELETE FROM maintenance_tickets WHERE threshold_id IS NULL');
    await assert.rejects(() => jobs.startJob({ user: { company_id: 4, plant_id: 9 }, body: { machine_id: 7, component_id: 3, job_start: new Date().toISOString() } }), error => error.status === 404);
    const occurrence = await jobs.startJob({ user: { company_id: 4, plant_id: 8 }, body: { machine_id: 7, component_id: 3, job_start: new Date().toISOString() } });
    await components.update(3, { cycle_time: '00:01:00', target: 80 }, 8, 4);
    const oldJob = (await pool.query('SELECT * FROM machine_current_job WHERE id=$1', [occurrence.id])).rows[0];
    assert.equal(oldJob.is_active, false);
    assert.equal(Number(oldJob.cycle_time_seconds), 120);
    assert.equal(oldJob.target_qty, 50);
    const active = (await pool.query('SELECT * FROM machine_current_job WHERE machine_id=7 AND is_active=TRUE')).rows[0];
    assert.equal(Number(active.cycle_time_seconds), 60);
    assert.equal(active.target_qty, 80);
    await components.update(3, { cycle_time: '00:01:00', target: 80 }, 8, 4);
    assert.equal((await pool.query('SELECT id FROM machine_current_job WHERE machine_id=7 AND is_active=TRUE')).rows[0].id, active.id, 'Unchanged save does not restart occurrence');
    await jobs.stopJob(7, 4, 8);
    await assert.rejects(() => lines.createLine({ user: { company_id: 4 }, body: { name: 'Foreign plant', plant_id: 9 } }), error => error.status === 404);
    const line = await lines.createLine({ user: { company_id: 8 }, body: { name: 'Sole plant auto-choice' } });
    assert.equal(line.plant_id, 18);
    await pool.query('INSERT INTO company_plans(company_id,max_machines) VALUES(8,1)');
    const results = await Promise.allSettled(['Quota A', 'Quota B'].map(serial => machines.createMachine({ user: { company_id: 8 }, body: { machine_serial_no: serial, plant_id: 18 } })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'Concurrent creation cannot exceed quota');
    assert.equal(results.find(result => result.status === 'rejected').reason.status, 402);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM machines WHERE company_id=8')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM machine_shift_config')).rows[0].n, 1);
    await pool.query('INSERT INTO plants VALUES(19,8); INSERT INTO shifts VALUES(4,19,8)');
    const createdMachine = results.find(result => result.status === 'fulfilled').value;
    await machines.updateMachine({ user: { company_id: 8 }, params: { id: createdMachine.id }, body: { plant_id: 19, line_id: null } });
    assert.deepEqual((await pool.query('SELECT plant_id,shift_id FROM machine_shift_config WHERE machine_id=$1', [createdMachine.id])).rows, [{ plant_id: 19, shift_id: 4 }], 'Plant move changes the timetable atomically');

    await pool.query(rollback);
    await pool.query(rollback);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM machine_current_job')).rows[0].n, 3, 'Rollback preserves job history');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM maintenance_tickets')).rows[0].n, 2, 'Rollback preserves ticket history');
    await pool.query('INSERT INTO machine_current_job(machine_id,company_id,is_active) VALUES(7,4,TRUE),(7,4,TRUE)');
    await assert.rejects(() => pool.query(migration), /Multiple active jobs/);
    await pool.query('ROLLBACK');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM machine_current_job WHERE is_active=TRUE')).rows[0].n, 2, 'Duplicate preflight does not delete jobs');
    await pool.query('UPDATE machine_current_job SET is_active=FALSE WHERE is_active=TRUE');
    await pool.query("INSERT INTO maintenance_tickets(company_id,machine_id,threshold_id,status) VALUES(4,7,5,'ASSIGNED')");
    await assert.rejects(() => pool.query(migration), /Multiple live preventive tickets/);
    await pool.query('ROLLBACK');
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM maintenance_tickets WHERE status IN ('OPEN','ASSIGNED')")).rows[0].n, 2, 'Duplicate preflight does not delete tickets');
    console.log('PMS PostgreSQL fixture passed: migration/reapply/rollback, duplicate preflight without data loss, tenant/plant placement, immutable job snapshots, concurrent quota, atomic shift links, plant-bound schedule/log/ticket/downtime reads and writes, unplaced records excluded and company-admin access preserved.');
  } finally {
    if (pool) await pool.end();
    if (running) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
