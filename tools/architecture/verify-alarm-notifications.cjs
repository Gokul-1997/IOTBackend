#!/usr/bin/env node
/* Verify alarm delivery against a new private Unix-socket PostgreSQL cluster.
 * This tool never loads .env, connects to an existing DB/Redis, sends mail,
 * opens a TCP listener or communicates with a machine controller. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '../..');
const pgBin = process.env.ALARM_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-alarm-fixture-'));
const migration = fs.readFileSync(path.join(repo, 'src/migrations/047_alarm_notifications.sql'), 'utf8');
const policyMigration = fs.readFileSync(path.join(repo, 'src/migrations/048_alarm_notification_policies.sql'), 'utf8');
const policyRollback = fs.readFileSync(path.join(repo, 'src/migrations/rollback/048_alarm_notification_policies_down.sql'), 'utf8');
const alarmColumns = ['notification_continuity_started_at', 'notification_priority_changed_at', 'severity_observed_at', 'severity_received_at', 'ended_received_at'];
const rollback = fs.readFileSync(path.join(repo, 'src/migrations/rollback/047_alarm_notifications_down.sql'), 'utf8');
let pool, running = false, delivered = [], socketFailure = false;
let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
function inject(relative, exports) {
  const filename = require.resolve(path.join(repo, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const schema = `
CREATE TABLE companies(id INT PRIMARY KEY, name TEXT, is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE plants(id INT PRIMARY KEY,company_id INT,is_active BOOLEAN DEFAULT TRUE,plant_name TEXT);
CREATE TABLE users(id INT PRIMARY KEY,company_id INT,plant_id INT,username TEXT,email TEXT,
  user_type TEXT DEFAULT 'company_user',is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE roles(id INT PRIMARY KEY,company_id INT,role_name TEXT,is_system BOOLEAN DEFAULT FALSE);
CREATE TABLE permissions(id INT PRIMARY KEY,permission_key TEXT);
CREATE TABLE user_roles(user_id INT REFERENCES users,role_id INT REFERENCES roles,PRIMARY KEY(user_id,role_id));
CREATE TABLE role_permissions(role_id INT REFERENCES roles,permission_id INT REFERENCES permissions,PRIMARY KEY(role_id,permission_id));
CREATE TABLE company_permissions(company_id INT REFERENCES companies,permission_id INT REFERENCES permissions,PRIMARY KEY(company_id,permission_id));
CREATE TABLE notification_preferences(user_id INT PRIMARY KEY REFERENCES users,notify_alarm BOOLEAN DEFAULT TRUE);
CREATE TABLE machines(id INT PRIMARY KEY,company_id INT REFERENCES companies,plant_id INT REFERENCES plants,
  machine_serial_no TEXT,machine_name TEXT,is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE machine_alarms(id BIGSERIAL PRIMARY KEY,company_id INT REFERENCES companies,machine_id INT REFERENCES machines,
  shift_id INT,
  alarm_type VARCHAR(50) NOT NULL DEFAULT 'ALARM',alarm_code VARCHAR(50),severity VARCHAR(20) NOT NULL DEFAULT 'HIGH',message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),ended_at TIMESTAMPTZ,is_resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX idx_alarms_open ON machine_alarms(company_id,started_at DESC) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX uq_alarm_open_per_machine_code ON machine_alarms(machine_id,COALESCE(alarm_code,alarm_type)) WHERE ended_at IS NULL;
CREATE TABLE notifications(id BIGSERIAL PRIMARY KEY,company_id INT REFERENCES companies,user_id INT REFERENCES users,
  type VARCHAR(50) DEFAULT 'INFO',title VARCHAR(200) NOT NULL,message TEXT,link VARCHAR(500),
  is_read BOOLEAN DEFAULT FALSE,read_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE telemetry_raw(company_id INT,machine_id INT,device_time BIGINT,received_at TIMESTAMPTZ,
  alarm BOOLEAN,machine_status TEXT DEFAULT 'IDLE');
CREATE INDEX telemetry_latest ON telemetry_raw(company_id,machine_id,received_at DESC);
CREATE TABLE ingest_gaps(company_id INT,machine_id INT,last_observed_at TIMESTAMPTZ,resumed_at TIMESTAMPTZ,gap_seconds BIGINT);
CREATE INDEX ingest_gaps_latest ON ingest_gaps(company_id,machine_id,resumed_at DESC);
INSERT INTO companies VALUES(4,'Own company',TRUE),(5,'Other company',TRUE),(6,'Disabled company',FALSE);
INSERT INTO plants VALUES(8,4,TRUE,'Own plant'),(10,4,TRUE,'Other plant'),(9,5,TRUE,'Foreign plant'),(11,6,TRUE,'Disabled company plant');
INSERT INTO machines VALUES(7,4,8,'CNC-7','Own machine',TRUE),(8,4,10,'CNC-8','Other plant machine',TRUE),
  (9,5,9,'CNC-9','Foreign machine',TRUE),(10,4,8,'CNC-10','Inactive machine',FALSE),(11,6,11,'CNC-11','Disabled company machine',TRUE);
INSERT INTO users(id,company_id,plant_id,username,is_active) VALUES
  (1,4,NULL,'Company administrator',TRUE),(2,4,8,'Own plant engineer',TRUE),
  (3,4,10,'Other plant engineer',TRUE),(4,4,NULL,'Company observer',TRUE),
  (5,4,8,'Inactive engineer',FALSE),(6,5,9,'Foreign engineer',TRUE),
  (7,4,8,'Personal alarm opt-out',TRUE),(8,4,8,'No company grant',TRUE),
  (9,4,8,'No alarm permission',TRUE),(11,6,11,'Disabled company engineer',TRUE);
INSERT INTO roles VALUES(1,NULL,'COMPANY_ADMIN',TRUE),(2,4,'ENGINEER',FALSE),(3,5,'ENGINEER',FALSE),
  (4,6,'ENGINEER',FALSE),(5,4,'UNGRANTED',FALSE),(6,4,'VIEWER',FALSE);
INSERT INTO permissions VALUES(1,'page:alarms:view'),(2,'page:analytics-alarms:view'),
  (3,'page:dashboard:view'),(4,'page:dashboard:live:view');
INSERT INTO company_permissions VALUES(4,1),(4,3),(4,4),(5,1),(6,1);
INSERT INTO role_permissions VALUES(2,1),(2,3),(2,4),(3,1),(4,1),(5,2);
INSERT INTO user_roles VALUES(1,1),(2,2),(3,2),(4,2),(5,2),(6,3),(7,2),(8,5),(9,6),(11,4);
INSERT INTO notification_preferences VALUES(7,FALSE);`;

(async () => {
  try {
    execFileSync(path.join(pgBin, 'initdb'), ['-D', path.join(directory, 'data'), '-U', 'alarm_fixture', '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
    execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'),
      '-o', `-F -k ${directory} -p 55447 -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    pool = new Pool({ host: directory, port: 55447, user: 'alarm_fixture', database: 'postgres', max: 8 });
    await pool.query(schema);
    const { missingAlarmColumns } = await import(pathToFileURL(path.resolve(repo, '../pms-backend/src/lib/schema-check.js')).href);
    check(await missingAlarmColumns(pool), alarmColumns, 'The collector refuses the pre-047/048 alarm schema');
    await pool.query(migration); await pool.query(migration);
    check(await missingAlarmColumns(pool), alarmColumns.slice(1), 'Migration 047 alone cannot satisfy the critical event collector');
    await pool.query(rollback); await pool.query(rollback);
    check((await pool.query("SELECT to_regclass('alarm_notification_rules') AS name")).rows[0].name, null, 'Empty 047 rollback is repeatable');
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machines')).rows[0].count, 5, 'Rollback preserves every machine');
    await pool.query(migration);
    // A previously enabled delayed rule is retained for history; migration
    // must not silently enroll the company in the new critical-only feature.
    await pool.query('INSERT INTO alarm_notification_rules(company_id,machine_id,enabled,delay_seconds) VALUES(4,7,TRUE,30)');
    await pool.query(policyMigration); await pool.query(policyMigration);
    check(await missingAlarmColumns(pool), [], 'Migration 048 satisfies the collector priority schema guard');
    check((await pool.query('SELECT COUNT(*)::int AS count FROM alarm_notification_policies')).rows[0].count, 0,
      'Migration does not silently enable company-wide critical notifications');
    check((await pool.query('SELECT enabled,delay_seconds FROM alarm_notification_rules')).rows, [{ enabled: true, delay_seconds: 30 }],
      'Migration preserves the old configuration without driving new notification behavior');
    await pool.query('TRUNCATE alarm_notification_rules');
    await pool.query(policyRollback); await pool.query(policyRollback);
    check((await pool.query("SELECT to_regclass('alarm_notification_events') AS name")).rows[0].name, null, 'Empty 048 rollback is repeatable');
    await pool.query(policyMigration);
    const shadowClient = await pool.connect();
    try {
      await shadowClient.query('CREATE SCHEMA alarm_shadow; CREATE TABLE alarm_shadow.machine_alarms(id BIGINT); SET search_path TO alarm_shadow,public');
      check(await missingAlarmColumns(shadowClient), alarmColumns, 'The collector checks the actual search-path table rather than another migrated table');
    } finally { await shadowClient.query('RESET search_path; DROP SCHEMA IF EXISTS alarm_shadow CASCADE'); shadowClient.release(); }
    inject('src/db.js', pool);
    inject('src/notifications/notification.service.js', { announceUnread: async ids => {
      delivered.push([...ids].sort((a, b) => a - b));
      if (socketFailure) throw new Error('Injected socket failure');
    } });
    const service = require(path.join(repo, 'src/alarms/alarm-notification.service'));
    const { alarmTransition, writeAlarmTransition } = await import(pathToFileURL(path.resolve(repo, '../pms-backend/src/lib/alarm-transition.js')).href);
    const actor = { id: 1, user_id: 1, company_id: 4, plant_id: null, roles: ['COMPANY_ADMIN'] };
    const epoch = Math.floor(Date.now() / 1000) - 20;
    const eventCount = async () => (await pool.query('SELECT COUNT(*)::int AS count FROM alarm_notification_events')).rows[0].count;
    const count = async () => (await pool.query('SELECT COUNT(*)::int AS count FROM notifications')).rows[0].count;
    const inbox = async () => (await pool.query('SELECT alarm_id,user_id,link,type,alarm_priority FROM notifications ORDER BY alarm_id,user_id')).rows;
    const run = options => service.processDueAlarms(options);
    async function reset() {
      await pool.query('TRUNCATE machine_alarms,notifications,alarm_notification_rules,alarm_notification_policies,telemetry_raw,ingest_gaps RESTART IDENTITY CASCADE');
      delivered = []; socketFailure = false;
    }
    async function enable(enabled = true, since = epoch - 3600) {
      const current = await service.getPolicy(actor);
      const result = await service.updatePolicy(actor, { enabled, expected_version: current.version });
      await pool.query('UPDATE alarm_notification_policies SET enabled_since=to_timestamp($1) WHERE company_id=4', [since]);
      return result;
    }
    async function reading({ machine = 7, company = 4, at = epoch, received = at, alarm = true } = {}) {
      await pool.query('INSERT INTO telemetry_raw(company_id,machine_id,device_time,received_at,alarm)VALUES($1,$2,$3,to_timestamp($4),$5)',
        [company,machine,at,received,alarm]);
    }
    async function alarm({ machine = 7, company = 4, start = epoch - 30, end = null, code = 'EX1000', severity = 'CRITICAL', resolved = false } = {}) {
      return (await pool.query(`INSERT INTO machine_alarms(company_id,machine_id,alarm_type,alarm_code,severity,message,started_at,ended_at,is_resolved)
        VALUES($1,$2,'Fixture controller alarm',$3,$4,'Controller details',to_timestamp($5),to_timestamp($6),$7) RETURNING id`,
      [company,machine,code,severity,start,end,resolved])).rows[0].id;
    }
    async function transition({ code = 'EX1000', severity = 'CRITICAL', machine = 7, company = 4,
      at = epoch - 3, received = at + 0.125, prev = { alarm: false, alarm_codes: [], alarm_severities: {} }, active = true, client = pool } = {}) {
      const item = { alarm_code: code, alarm_type: 'Fixture controller alarm', alarm_severity: severity, alarm_message: `Observed ${severity}` };
      const change = alarmTransition({ companyId: company, machineId: machine, shiftId: null, prev,
        isAlarm: active, alarms: active ? [item] : [], deviceTime: at, receivedAt: new Date(received * 1000).toISOString() });
      if (change) await writeAlarmTransition(client, change);
      return { alarm: active, alarm_codes: active ? [code] : [], alarm_severities: active ? { [code]: severity.trim().toUpperCase() } : {} };
    }

    await reset();
    check((await service.getPolicy(actor)).enabled, false, 'Critical notifications are off until a company administrator enables them');
    check((await service.getPolicy(actor)).configured, false, 'A missing company configuration is visible as unconfigured');
    await transition(); await run(); check(await count(), 0, 'An unconfigured company never receives a critical alert');
    const saved = await enable();
    check(saved.enabled, true, 'The company administrator can enable critical alerts for the fleet');
    check(saved.counts.machines, 2, 'Company configuration counts only active company machines');
    const beforeSameSave = (await pool.query('SELECT version,enabled_since FROM alarm_notification_policies WHERE company_id=4')).rows[0];
    await service.updatePolicy(actor, { enabled: true, expected_version: saved.version });
    check((await pool.query('SELECT version,enabled_since FROM alarm_notification_policies WHERE company_id=4')).rows[0], beforeSameSave,
      'Saving the same value does not restart eligibility or increment its version');
    await assert.rejects(() => service.updatePolicy(actor, { enabled: false, expected_version: 0 }), error => error.status === 409); assertions++;
    for (const body of [{ enabled: 'true', expected_version: 1 }, { enabled: true, expected_version: -1 },
      { enabled: true, expected_version: '1' }, { enabled: true }]) {
      await assert.rejects(() => service.updatePolicy(actor, body), error => error.status === 400); assertions++;
    }
    await assert.rejects(() => service.getPolicy({ ...actor, roles: ['ENGINEER'] }), error => error.status === 403); assertions++;
    await assert.rejects(() => service.getPolicy({ ...actor, is_snt_super: true }), error => error.status === 403); assertions++;
    await assert.rejects(() => pool.query('INSERT INTO alarm_notification_policies(company_id,enabled) VALUES(999,TRUE)'), error => error.code === '23503'); assertions++;

    await reset(); await enable();
    let state = await transition();
    const shortId = (await pool.query('SELECT id FROM machine_alarms')).rows[0].id;
    await transition({ active: false, at: epoch, prev: state });
    check((await pool.query('SELECT ended_at IS NOT NULL AS cleared FROM machine_alarms WHERE id=$1', [shortId])).rows[0].cleared, true,
      'A three-second critical alarm has physically cleared before dispatch');
    await Promise.all([run(),run(),run()]);
    check((await inbox()).map(row => row.user_id), [1,2,4], 'Only authorized active own-plant/company recipients receive the accepted critical occurrence');
    check((await inbox()).every(row => row.type === 'ALARM' && row.alarm_priority === 'critical'), true, 'The inbox contains only the critical alarm priority');
    check(delivered.flat().every(id => [1,2,4].includes(Number(id))), true, 'Socket unread updates target only eligible recipients');
    check((await pool.query('SELECT message FROM notifications LIMIT 1')).rows[0].message.includes('Still active after'), false,
      'Immediate messages never claim a cleared alarm remains active');
    await run(); check(await count(), 3, 'Repeated workers never repeat the physical occurrence');

    for (const [label, received, expected] of [
      ['received after enabling within the same device second', epoch + 0.75, 3],
      ['received before enabling within the same device second', epoch + 0.25, 0]
    ]) {
      await reset(); await enable(true, epoch + 0.5);
      state = await transition({ at: epoch, received });
      await transition({ active: false, at: epoch + 1, received: epoch + 1.125, prev: state });
      check((await pool.query('SELECT ended_at IS NOT NULL AS cleared FROM machine_alarms')).rows[0].cleared, true,
        `The fractional-enable boundary alarm already cleared: ${label}`);
      await run(); check(await count(), expected,
        `True network receipt distinguishes a critical event ${label}`);
    }

    for (const severity of ['NORMAL','HIGH','MEDIUM','LOW','INFO','INFORMATION','INFORMATIONAL','MESSAGE','UNKNOWN']) {
      await reset(); await enable(); await transition({ severity }); await reading(); await run();
      check(await count(), 0, `${severity} stays in history and cannot create a notification`);
      check(await eventCount(), 0, `${severity} creates no unused critical outbox work`);
      check((await pool.query('SELECT COUNT(*)::int AS count FROM machine_alarms')).rows[0].count, 1, `${severity} remains recorded for reporting`);
    }
    for (const severity of [' critical ','FATAL',' emergency ']) {
      await reset(); await enable(); await transition({ severity }); await run();
      check(await count(), 3, `${severity} uses the shared normalized critical classification`);
    }
    await reset(); await enable();
    await pool.query('INSERT INTO alarm_notification_rules(company_id,machine_id,enabled,delay_seconds)VALUES(4,7,TRUE,1)');
    await transition({ severity: 'NORMAL' }); await reading(); await run();
    check(await count(), 0, 'Old enabled per-machine delayed rules cannot send noncritical notifications in this phase');

    await reset(); await enable();
    await pool.query("INSERT INTO machines VALUES(12,4,8,'CNC-12','Future fleet machine',TRUE)");
    await transition({ machine: 12 }); await run(); check(await count(), 3, 'Future company machines inherit critical notifications automatically');
    await pool.query('DELETE FROM machine_alarms WHERE machine_id=12'); await pool.query('DELETE FROM machines WHERE id=12');

    await reset(); await enable();
    state = await transition({ severity: 'NORMAL', at: epoch - 6 });
    const originalId = (await pool.query('SELECT id FROM machine_alarms')).rows[0].id;
    await run(); check(await count(), 0, 'A normal alarm starts without an alert');
    state = await transition({ severity: 'CRITICAL', at: epoch - 5, prev: state });
    await run(); check(await count(), 3, 'A same-code escalation from normal to critical alerts immediately');
    check((await pool.query('SELECT id FROM machine_alarms')).rows.map(row => row.id), [originalId], 'Escalation retains one physical alarm identity');
    const initialEvents = await eventCount();
    state = await transition({ severity: 'CRITICAL', at: epoch - 4, prev: state });
    check(await eventCount(), initialEvents, 'Unchanged readings create no additional events or writes');
    state = await transition({ severity: 'FATAL', at: epoch - 3, prev: state });
    check(await eventCount(), initialEvents, 'Changing a critical alias does not create another critical event');
    state = await transition({ severity: 'NORMAL', at: epoch - 2, prev: state });
    state = await transition({ severity: 'EMERGENCY', at: epoch - 1, prev: state });
    await run(); check(await count(), 3, 'Repeated critical escalation within one occurrence does not spam notifications');
    await transition({ active: false, at: epoch, prev: state });
    await transition({ at: epoch + 1 }); await run(); check(await count(), 6, 'A physically cleared then recurring critical alarm alerts again');

    await reset(); await enable();
    state = await transition({ at: epoch - 4, received: epoch - 3.9 });
    await transition({ active: false, at: epoch - 4, received: epoch - 3.8, prev: state });
    await transition({ at: epoch - 4, received: epoch - 3.7 });
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machine_alarms')).rows[0].count, 2,
      'Clear and recur within the same device second preserve two real alarm occurrences');
    await Promise.all([run(),run()]); check(await count(), 6, 'Each distinct same-second critical occurrence notifies once');
    await transition({ at: epoch - 4, received: epoch - 3.9 });
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machine_alarms')).rows[0].count, 2,
      'Replaying the older same-second open cannot create a third occurrence');

    await reset(); await enable();
    state = await transition({ severity: 'NORMAL', at: epoch - 4, received: epoch - 3.8 });
    state = await transition({ at: epoch - 4, received: epoch - 3.7, prev: state });
    await transition({ severity: 'NORMAL', at: epoch - 4, received: epoch - 3.9,
      prev: { alarm: true, alarm_codes: ['EX1000'], alarm_severities: { EX1000: 'CRITICAL' } } });
    check((await pool.query('SELECT severity FROM machine_alarms')).rows[0].severity, 'CRITICAL', 'Older same-device-second replay cannot demote the newer critical snapshot');
    await run(); check(await count(), 3, 'Correctly ordered critical escalation remains deliverable once');
    await transition({ active: false, at: epoch - 2, prev: state });
    await transition({ severity: 'NORMAL', at: epoch - 4, received: epoch - 3.8 });
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machine_alarms')).rows[0].count, 1, 'Replay of a known closed occurrence cannot invent a new open period');

    await reset(); await enable(false);
    state = await transition({ at: epoch - 10 }); await reading({ at: epoch - 8 }); await run();
    check(await count(), 0, 'A disabled company does not deliver critical events');
    await enable(true, epoch - 5); await run(); check(await count(), 0, 'Enabling waits for an accepted observation after the enable boundary');
    await reading({ at: epoch - 4 }); await run(); check(await count(), 3, 'An already-active critical alarm alerts on fresh confirmation after enabling');
    await run(); check(await count(), 3, 'The activation fallback is also once per physical occurrence');
    await enable(false); await transition({ at: epoch, code: 'EX2000' }); await run(); check(await count(), 3, 'Disabling stops new critical notifications');

    await reset(); await enable(false);
    state = await transition({ at: epoch - 10 }); await transition({ active: false, at: epoch - 7, prev: state });
    await reading({ at: epoch - 6, alarm: false }); await enable(true, epoch - 5); await run();
    check(await count(), 0, 'Enabling cannot flood the inbox with historical cleared critical alarms');
    await reset(); await enable();
    const historical = await alarm({ start: epoch - 3600 }); await transition({ prev: null });
    check(await eventCount(), 0, 'Cold discovery of unchanged historical critical state creates no fake new occurrence event');
    check((await pool.query('SELECT id FROM machine_alarms')).rows.map(row => row.id), [historical], 'Cold reconciliation preserves reporting history');
    await run(); check(await count(), 0, 'A cold collector alone cannot dispatch without a fresh accepted observation');
    await reading(); await run(); check(await count(), 3, 'Fresh physically-active critical confirmation can notify after cold reconciliation');

    for (const [label, options] of [
      ['stale device', { at: epoch - 600, received: epoch }], ['stale arrival', { at: epoch, received: epoch - 600 }],
      ['future device', { at: epoch + 1000, received: epoch }], ['future arrival', { at: epoch, received: epoch + 1000 }],
      ['foreign company without opt-in', { machine: 9, company: 5 }], ['inactive machine', { machine: 10 }],
      ['inactive company', { machine: 11, company: 6 }]
    ]) {
      await reset(); await enable(); await transition(options); await run();
      check(await count(), 0, `${label} cannot manufacture a critical notification`);
    }
    for (const latest of [{ at: epoch + 1000 }, { received: epoch + 1000 }, { at: epoch - 600 }, { alarm: false }]) {
      await reset(); await enable(); await alarm({ start: epoch - 3600 });
      await reading({ received: epoch - 1 }); await reading({ received: epoch, ...latest }); await run();
      check(await count(), 0, 'The active-alarm fallback cannot skip a newer invalid or cleared observation');
    }
    await reset(); await enable(); await transition();
    await pool.query('UPDATE plants SET is_active=FALSE WHERE id=8'); await run();
    check(await count(), 0, 'An inactive assigned plant does not notify');
    await pool.query('UPDATE plants SET is_active=TRUE WHERE id=8');
    await reset(); await enable(); await transition();
    await pool.query('DELETE FROM company_permissions WHERE company_id=4 AND permission_id IN(1,3)'); await run();
    check(await count(), 0, 'Revoking company alarm page grants prevents administrator delivery too');
    await pool.query('INSERT INTO company_permissions VALUES(4,1),(4,3)'); await run();
    check(await count(), 3, 'Restored permission can deliver the still-fresh pending critical event');
    await reset(); await enable(); await alarm({ resolved: true }); await reading(); await run();
    check(await count(), 3, 'Manual acknowledgement does not falsely clear a physically active critical alarm');

    await reset(); await enable();
    const listener = await pool.connect(), producer = await pool.connect(), wakeups = [];
    const onNotification = notification => wakeups.push(notification.channel);
    listener.on('notification', onNotification);
    try {
      await listener.query('LISTEN cnc_alarm_events'); await producer.query('BEGIN'); await transition({ client: producer });
      check(await eventCount(), 0, 'Uncommitted alarm events are invisible to dispatch');
      await new Promise(resolve => setTimeout(resolve,30)); check(wakeups, [], 'NOTIFY cannot escape before COMMIT');
      await producer.query('ROLLBACK'); await new Promise(resolve => setTimeout(resolve,30));
      check(await eventCount(), 0, 'ROLLBACK removes alarm and event together'); check(wakeups, [], 'ROLLBACK discards the wakeup');
      await producer.query('BEGIN'); await transition({ client: producer }); await producer.query('COMMIT');
      await new Promise(resolve => setTimeout(resolve,30));
      check(wakeups, ['cnc_alarm_events'], 'Committed accepted events wake the API through PostgreSQL NOTIFY');
      check(await eventCount(), 1, 'Every committed wakeup has a durable event behind it');
    } finally { await listener.query('UNLISTEN cnc_alarm_events'); listener.removeListener('notification', onNotification); listener.release(); producer.release(); }
    await Promise.all([run(),run()]); check(await count(), 3, 'Concurrent recovery dispatch consumes a committed critical event once');

    await reset(); await enable(); await transition();
    await pool.query(`CREATE FUNCTION refuse_alarm_inbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected notification insert failure'; END $$;
      CREATE TRIGGER refuse_alarm_inbox BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION refuse_alarm_inbox();`);
    await assert.rejects(() => run(), /Injected notification insert failure/); assertions++;
    check(await count(), 0, 'A failed inbox insert leaves no partial recipients');
    check((await pool.query('SELECT processed_at FROM alarm_notification_events')).rows[0].processed_at, null, 'Failed dispatch leaves the event retryable');
    check((await pool.query('SELECT notification_sent_at FROM machine_alarms')).rows[0].notification_sent_at, null, 'Failed dispatch leaves the occurrence undelivered');
    await pool.query('DROP TRIGGER refuse_alarm_inbox ON notifications'); await run(); check(await count(), 3, 'Retry after recovery delivers once');
    await reset(); await enable(); await transition(); socketFailure = true; await run();
    check(await count(), 3, 'Socket failure cannot undo durable inbox rows');
    socketFailure = false; await run(); check(await count(), 3, 'Retry after socket failure does not duplicate delivery');

    // Read isolation survives an account being reassigned to another company.
    const unreadEvents = [];
    inject('src/lib/realtime.js', { isLive: () => true, emitToUser: (id,event,payload) => unreadEvents.push({ id,event,payload }) });
    const notificationPath = require.resolve(path.join(repo,'src/notifications/notification.service')); delete require.cache[notificationPath];
    const notificationReads = require(notificationPath);
    const oldNotification = (await pool.query('SELECT id FROM notifications WHERE user_id=2 AND company_id=4')).rows[0].id;
    check(await notificationReads.getUnreadCount(2,4), 1, 'The original company badge contains its critical alarm');
    await pool.query('UPDATE users SET company_id=5,plant_id=9 WHERE id=2');
    const movedInbox = await notificationReads.getNotifications({ user_id: 2,company_id: 5 });
    check(movedInbox.data, [], 'A reassigned account cannot read its former company inbox');
    check(movedInbox.pagination.total, 0, 'Moved-account totals exclude former company records');
    check(movedInbox.unread_count, 0, 'Moved-account badges exclude former company records');
    check(await notificationReads.getUnreadCount(2,5), 0, 'Dedicated unread counts use authenticated company scope');
    await notificationReads.announceUnread([2]); check(unreadEvents.at(-1), { id: 2,event: 'unreadCount',payload: { count: 0 } }, 'Live badges remain company scoped after reassignment');
    const temporaryRows = (await pool.query("INSERT INTO notifications(company_id,user_id,type,title)VALUES(5,2,'INFO','Current company'),(5,6,'INFO','Another user') RETURNING id,user_id")).rows;
    const ownNew = temporaryRows.find(row => row.user_id === 2).id, foreignUser = temporaryRows.find(row => row.user_id === 6).id;
    const currentInbox = await notificationReads.getNotifications({ user_id: 2,company_id: 5 });
    check(currentInbox.data.map(row => row.id), [ownNew], 'Only the current company/user rows are readable');
    check(currentInbox.unread_count, 1, 'Current company unread counts continue normally');
    await notificationReads.markRead({ user_id: 2,company_id: 5,notification_id: oldNotification });
    check((await pool.query('SELECT is_read FROM notifications WHERE id=$1',[oldNotification])).rows[0].is_read, false, 'Single read cannot modify a former company row');
    await notificationReads.markAllRead(2,5);
    const readStates = (await pool.query('SELECT id,is_read FROM notifications WHERE id=ANY($1::bigint[])',[[oldNotification,ownNew,foreignUser]])).rows;
    check(readStates.find(row => row.id === oldNotification).is_read, false, 'Mark all preserves former company rows');
    check(readStates.find(row => row.id === ownNew).is_read, true, 'Mark all updates current user/company rows');
    check(readStates.find(row => row.id === foreignUser).is_read, false, 'Mark all preserves another user rows');
    check((await notificationReads.getNotifications({ user_id: 2,company_id: 5,unread_only: 'true' })).data, [], 'Unread filtering stays within company/user scope');
    check(await notificationReads.getUnreadCount(2,5), 0, 'The current company badge clears after reading');
    await pool.query('DELETE FROM notifications WHERE id=ANY($1::bigint[])',[temporaryRows.map(row => row.id)]);
    await pool.query('UPDATE users SET company_id=4,plant_id=8 WHERE id=2');
    check(await notificationReads.getUnreadCount(2,4), 1, 'The historical critical inbox remains intact');
    const rollbackClient = await pool.connect();
    try { await assert.rejects(() => rollbackClient.query(policyRollback), /Cannot roll back 048/); assertions++; await rollbackClient.query('ROLLBACK'); }
    finally { rollbackClient.release(); }
    check(await count(), 3, 'Refused rollback preserves inbox history');
    check(await eventCount(), 1, 'Refused rollback preserves accepted critical events');
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machine_alarms')).rows[0].count, 1, 'Refused rollback preserves alarm history');
    check((await pool.query('SELECT enabled FROM alarm_notification_policies WHERE company_id=4')).rows[0].enabled, true, 'Refused rollback preserves company configuration');
    console.log(`Critical alarm PostgreSQL fixture passed (${assertions} assertions): 047/048 migration/reapply/rollback, explicit fleet opt-in/future machines, normal/info history only, 3-second critical after clear, same-code escalation and same-second recurrence, shared aliases, monotonic replay, active confirmation after enable, transactional outbox/NOTIFY, concurrent exactly-once delivery, stale/future/inactive protection, tenant/plant/permission/personal preferences, inbox reassignment isolation, failed-dispatch retry and socket durability.`);
  } finally {
    if (pool) await pool.end();
    if (running) execFileSync(path.join(pgBin,'pg_ctl'),['-D',path.join(directory,'data'),'-m','immediate','-w','stop'],{ stdio: 'pipe' });
    fs.rmSync(directory,{ recursive: true,force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
