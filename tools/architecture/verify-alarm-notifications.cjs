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
    pool = new Pool({ host: directory, port: 55447, user: 'alarm_fixture', database: 'postgres', max: 6 });
    await pool.query(schema);
    const { missingAlarmColumns } = await import(pathToFileURL(path.resolve(repo,
      '../pms-backend/src/lib/schema-check.js')).href);
    check(await missingAlarmColumns(pool), ['notification_continuity_started_at'], 'The collector startup probe rejects the schema before migration 047');
    await pool.query(migration); await pool.query(migration);
    check(await missingAlarmColumns(pool), [], 'The collector startup probe accepts the migrated schema');
    const shadowClient = await pool.connect();
    try {
      await shadowClient.query(`CREATE SCHEMA alarm_shadow;
        CREATE TABLE alarm_shadow.machine_alarms(id BIGINT);
        SET search_path TO alarm_shadow,public`);
      check(await missingAlarmColumns(shadowClient), ['notification_continuity_started_at'],
        'A migrated public table cannot hide a missing column on the actual search-path target');
    } finally {
      await shadowClient.query('RESET search_path; DROP SCHEMA IF EXISTS alarm_shadow CASCADE');
      shadowClient.release();
    }
    await pool.query(rollback); await pool.query(rollback);
    check((await pool.query("SELECT to_regclass('alarm_notification_rules') AS name")).rows[0].name, null, 'Empty rollback removes the rule table');
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machines')).rows[0].count, 5, 'Rollback preserves machines');
    await pool.query(migration);
    inject('src/db.js', pool);
    inject('src/notifications/notification.service.js', { announceUnread: async ids => {
      delivered.push([...ids].sort((a, b) => a - b));
      if (socketFailure) throw new Error('Injected socket failure');
    } });
    const service = require(path.join(repo, 'src/alarms/alarm-notification.service'));
    const { alarmTransition, writeAlarmTransition } = await import(pathToFileURL(path.resolve(repo,
      '../pms-backend/src/lib/alarm-transition.js')).href);
    const actor = { id: 1, user_id: 1, company_id: 4, plant_id: null, roles: ['COMPANY_ADMIN'] };
    const epoch = Math.floor(Date.now() / 1000) - 10;
    async function reset() {
      await pool.query('TRUNCATE machine_alarms,notifications,alarm_notification_rules,telemetry_raw,ingest_gaps RESTART IDENTITY CASCADE');
      delivered = []; socketFailure = false;
    }
    async function rule({ machine = 7, company = 4, delay = 30, enabled = true, since = epoch - 3600 } = {}) {
      await pool.query(`INSERT INTO alarm_notification_rules(company_id,machine_id,enabled,delay_seconds,enabled_since)
        VALUES($1,$2,$3,$4,to_timestamp($5)) ON CONFLICT(company_id,machine_id) DO UPDATE SET
        enabled=EXCLUDED.enabled,delay_seconds=EXCLUDED.delay_seconds,enabled_since=EXCLUDED.enabled_since`,
      [company, machine, enabled, delay, since]);
    }
    async function reading({ machine = 7, company = 4, at = epoch, received = epoch, alarm = true } = {}) {
      await pool.query('INSERT INTO telemetry_raw(company_id,machine_id,device_time,received_at,alarm)VALUES($1,$2,$3,to_timestamp($4),$5)',
        [company, machine, at, received, alarm]);
    }
    async function alarm({ machine = 7, company = 4, start = epoch - 30, end = null, resolved = false, code = 'EX1046' } = {}) {
      const { rows } = await pool.query(`INSERT INTO machine_alarms(company_id,machine_id,alarm_type,alarm_code,message,started_at,ended_at,is_resolved)
        VALUES($1,$2,'Door open',$3,'Close machine door',to_timestamp($4),to_timestamp($5),$6) RETURNING id`,
        [company, machine, code, start, end, resolved]);
      return rows[0].id;
    }
    const inbox = async () => (await pool.query('SELECT alarm_id,user_id,link,type FROM notifications ORDER BY alarm_id,user_id')).rows;
    const count = async () => (await pool.query('SELECT COUNT(*)::int AS count FROM notifications')).rows[0].count;
    const marker = async id => (await pool.query('SELECT notification_sent_at FROM machine_alarms WHERE id=$1', [id])).rows[0].notification_sent_at;
    const run = options => service.processDueAlarms(options);

    await reset(); await rule(); const first = await alarm({ start: epoch - 29 }); await reading();
    await run(); check(await count(), 0, 'A 29-second confirmed alarm does not meet a 30-second policy');
    await reading({ at: epoch + 1, received: epoch + 1 });
    await Promise.all([run(), run(), run()]);
    check((await inbox()).map(row => row.user_id), [1, 2, 4], 'Only authorized, active own-plant/company recipients get the alarm');
    check((await inbox()).every(row => row.type === 'ALARM'), true, 'The inbox uses the alarm category');
    check(Boolean(await marker(first)), true, 'The completed dispatch has a durable marker');
    check(delivered.flat().every(id => [1, 2, 4].includes(Number(id))), true, 'Live unread updates are only sent to eligible recipients');
    await run(); check(await count(), 3, 'Repeated worker passes do not repeat the occurrence');
    await pool.query('UPDATE machine_alarms SET ended_at=to_timestamp($2) WHERE id=$1', [first, epoch + 2]);
    const second = await alarm({ start: epoch - 30 }); await run();
    check(await count(), 6, 'Clearing and recurring creates a separate alarm occurrence');
    check(Boolean(await marker(second)), true, 'The new occurrence has its own marker');

    await reset(); await rule({ delay: 600 }); await alarm({ start: epoch - 599 }); await reading();
    await run(); check(await count(), 0, 'Ten-minute rules wait for 600 confirmed seconds');
    await reading({ at: epoch + 1, received: epoch + 1 }); await run();
    check(await count(), 3, 'A ten-minute confirmed alarm notifies once');

    await reset(); await rule(); await alarm({ start: epoch - 300, end: epoch - 297 }); await reading({ alarm: false });
    await run(); check(await count(), 0, 'A three-second transient that cleared never notifies');
    await reset(); await rule(); await alarm({ resolved: true }); await reading(); await run();
    check(await count(), 3, 'Acknowledgement alone does not claim that a controller alarm cleared');

    const suppressionCases = [
      ['disabled rule', { enabled: false }, {}, {}],
      ['inactive machine', { machine: 10 }, { machine: 10 }, { machine: 10 }],
      ['inactive company', { machine: 11, company: 6 }, { machine: 11, company: 6 }, { machine: 11, company: 6 }],
      ['device observation is stale', {}, { start: epoch - 600 }, { at: epoch - 121 }],
      ['network arrival is stale', {}, { start: epoch - 600 }, { received: epoch - 121 }],
      ['queued historical observations', {}, { start: epoch - 1000 }, { at: epoch - 600, received: epoch }],
      ['future device observation', {}, {}, { at: epoch + 1000 }],
      ['latest telemetry cleared its alarm', {}, {}, { alarm: false }],
      ['no confirmed telemetry', {}, {}, null]
    ];
    for (const [name, ruleOptions, alarmOptions, readingOptions] of suppressionCases) {
      await reset(); await rule(ruleOptions); await alarm(alarmOptions); if (readingOptions) await reading(readingOptions);
      await run(); check(await count(), 0, `${name} does not create a false alarm notification`);
    }
    await reset(); await rule(); await alarm({ start: epoch - 3600 }); await reading();
    await pool.query(`INSERT INTO ingest_gaps VALUES(4,7,to_timestamp($1),to_timestamp($2),$3)`, [epoch - 600, epoch - 29, 571]);
    await run(); check(await count(), 0, 'An offline gap resets confirmed duration without changing reporting history');
    await reading({ at: epoch + 1, received: epoch + 1 }); await run();
    check(await count(), 3, 'After reconnect, a fresh complete threshold can qualify');

    await reset(); await rule({ since: epoch - 29 }); await alarm({ start: epoch - 3600 }); await reading();
    await run(); check(await count(), 0, 'Enabling a rule does not flood the inbox with old alarms');
    await reading({ at: epoch + 1, received: epoch + 1 }); await run();
    check(await count(), 3, 'An old alarm qualifies only after confirmed duration since enabling');

    await reset(); await rule(); const coldAlarm = await alarm({ start: epoch - 3600 });
    const coldAt = epoch - 40;
    const coldTransition = at => alarmTransition({ companyId: 4, machineId: 7, shiftId: null,
      prev: null, isAlarm: true, alarms: [{ alarm_code: 'EX1046', alarm_type: 'Door open' }], deviceTime: at });
    await writeAlarmTransition(pool, coldTransition(coldAt));
    const coldState = (await pool.query(`SELECT EXTRACT(EPOCH FROM started_at)::bigint AS started,
      EXTRACT(EPOCH FROM notification_continuity_started_at)::bigint AS confirmed FROM machine_alarms WHERE id=$1`, [coldAlarm])).rows[0];
    check(Number(coldState.started), epoch - 3600, 'Unknown-baseline reconciliation preserves reporting start time');
    check(Number(coldState.confirmed), coldAt, 'Cold collector starts notification continuity at its first confirmed observation');
    await writeAlarmTransition(pool, coldTransition(coldAt - 10));
    check(Number((await pool.query('SELECT EXTRACT(EPOCH FROM notification_continuity_started_at)::bigint AS confirmed FROM machine_alarms WHERE id=$1', [coldAlarm])).rows[0].confirmed),
      coldAt, 'Replaying an older journal transition cannot move the continuity boundary backwards');
    await reading({ at: coldAt, received: coldAt }); await run();
    check(await count(), 0, 'An old alarm with no persisted ingest gap cannot notify immediately after cold startup');
    await reading({ at: coldAt + 29, received: coldAt + 29 }); await run();
    check(await count(), 0, 'A cold-start alarm still waits for all 30 confirmed seconds');
    await reading({ at: coldAt + 30, received: coldAt + 30 }); await run();
    check(await count(), 3, 'A cold-start alarm can notify after its new confirmed qualification window');

    for (const latest of [{ at: epoch + 1000 }, { received: epoch + 1000 }, { at: epoch - 600 }, { alarm: false }]) {
      await reset(); await rule(); await alarm({ start: epoch - 3600 }); await reading({ received: epoch - 1 });
      await reading({ received: epoch, ...latest }); await run();
      check(await count(), 0, 'A newer invalid or cleared observation cannot fall back to an older alarm sample');
    }

    await reset(); await rule(); const failed = await alarm(); await reading();
    await pool.query(`CREATE FUNCTION refuse_alarm_inbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected notification insert failure'; END $$;
      CREATE TRIGGER refuse_alarm_inbox BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION refuse_alarm_inbox();`);
    try { await run(); } catch (error) { assert.match(error.message, /Injected notification insert failure/); }
    check(await count(), 0, 'A rejected inbox insert leaves no partial recipients');
    check(await marker(failed), null, 'The failed transaction does not mark an alarm delivered');
    await pool.query('DROP TRIGGER refuse_alarm_inbox ON notifications'); await run();
    check(await count(), 3, 'A failed dispatch retries successfully after database recovery');

    await reset(); await rule(); const durable = await alarm(); await reading(); socketFailure = true;
    try { await run(); } catch (error) { assert.match(error.message, /Injected socket failure/); }
    check(await count(), 3, 'A socket failure cannot undo durable inbox rows');
    check(Boolean(await marker(durable)), true, 'A socket failure cannot undo the occurrence marker');
    socketFailure = false; await run(); check(await count(), 3, 'Retry after socket failure does not duplicate notifications');

    // API services use a real pool too. No HTTP server or auth bypass is needed
    // to verify validation, tenancy, and transactional configuration semantics.
    await reset();
    for (const body of [{ delay_seconds: 0 }, { delay_seconds: 86401 }, { delay_seconds: 0.5 },
      { delay_seconds: '30' }, { enabled: 'true' }]) {
      await assert.rejects(() => service.updateRule(actor, 7, { enabled: true, delay_seconds: 30, ...body }), error => error.status === 400,
        `Invalid rule patch ${JSON.stringify(body)} must be rejected`); assertions++;
    }
    await assert.rejects(() => service.updateRule(actor, 9, { enabled: true, delay_seconds: 30 }), error => error.status === 404); assertions++;
    await service.updateRule(actor, 7, { enabled: true, delay_seconds: 30 });
    check((await pool.query('SELECT enabled,delay_seconds FROM alarm_notification_rules WHERE company_id=4 AND machine_id=7')).rows,
      [{ enabled: true, delay_seconds: 30 }], 'A company can save a 30-second machine rule');
    const before = (await pool.query('SELECT enabled_since FROM alarm_notification_rules WHERE company_id=4 AND machine_id=7')).rows[0].enabled_since;
    await pool.query("UPDATE alarm_notification_rules SET enabled_since=NOW()-INTERVAL '1 hour'");
    await service.updateRule(actor, 7, { enabled: true, delay_seconds: 60 });
    const after = (await pool.query('SELECT enabled_since,delay_seconds FROM alarm_notification_rules WHERE company_id=4 AND machine_id=7')).rows[0];
    check(after.delay_seconds, 60, 'One-minute policy is supported');
    check(after.enabled_since >= before, true, 'Changing the threshold starts a fresh observation window');
    await service.updateRule(actor, 7, { enabled: true, delay_seconds: 60 });
    check((await pool.query('SELECT enabled_since FROM alarm_notification_rules WHERE company_id=4 AND machine_id=7')).rows[0].enabled_since,
      after.enabled_since, 'Saving an unchanged rule does not indefinitely restart qualification');
    const scoped = await service.getRules(actor, { page: 1, limit: 100 });
    const serialized = JSON.stringify(scoped);
    check(serialized.includes('CNC-7'), true, 'Rule listing includes the authorized machine');
    check(serialized.includes('CNC-8'), true, 'Company administrators can configure both company plants');
    check(serialized.includes('CNC-9') || serialized.includes('CNC-10'), false, 'Rule listing hides foreign and inactive machines');
    await assert.rejects(() => service.getRules({ ...actor, roles: ['ENGINEER'] }), error => error.status === 403); assertions++;
    await assert.rejects(() => service.getRules({ ...actor, is_snt_super: true }), error => error.status === 403); assertions++;
    await assert.rejects(() => pool.query(`INSERT INTO alarm_notification_rules(company_id,machine_id,delay_seconds)VALUES(5,7,30)`), error => error.code === '23503'); assertions++;
    await assert.rejects(() => pool.query('UPDATE alarm_notification_rules SET delay_seconds=0'), error => error.code === '23514'); assertions++;

    await reset(); await rule(); await alarm(); await reading();
    await pool.query('DELETE FROM company_permissions WHERE company_id=4 AND permission_id IN (1,3)');
    await run(); check(await count(), 0, 'Revoking company alarm pages also prevents administrator delivery');
    await pool.query('INSERT INTO company_permissions VALUES(4,1),(4,3)');
    await run(); check(await count(), 3, 'Restoring an authorized page allows the pending occurrence to deliver');

    // Use the real inbox reader against the same database. The worker keeps
    // its earlier captured announcement stub, so no external service is used.
    const unreadEvents = [];
    inject('src/lib/realtime.js', { isLive: () => true,
      emitToUser: (id, event, payload) => unreadEvents.push({ id, event, payload }) });
    const notificationPath = require.resolve(path.join(repo, 'src/notifications/notification.service'));
    delete require.cache[notificationPath];
    const notificationReads = require(notificationPath);
    const oldNotification = (await pool.query('SELECT id FROM notifications WHERE user_id=2 AND company_id=4')).rows[0].id;
    check(await notificationReads.getUnreadCount(2, 4), 1, 'The original company inbox has its expected unread alarm');
    await pool.query('UPDATE users SET company_id=5,plant_id=9 WHERE id=2');
    const emptyNewInbox = await notificationReads.getNotifications({ user_id: 2, company_id: 5 });
    check(emptyNewInbox.data, [], 'A moved account cannot read its historical company inbox');
    check(emptyNewInbox.pagination.total, 0, 'The moved account list total excludes historical company rows');
    check(emptyNewInbox.unread_count, 0, 'The moved account list badge excludes historical company rows');
    check(await notificationReads.getUnreadCount(2, 5), 0, 'The dedicated unread count uses the authenticated company');
    await notificationReads.announceUnread([2]);
    check(unreadEvents.at(-1), { id: 2, event: 'unreadCount', payload: { count: 0 } },
      'Live badges do not include rows belonging to the account previous company');
    const temporaryRows = (await pool.query(`INSERT INTO notifications(company_id,user_id,type,title)
      VALUES(5,2,'INFO','Current company notice'),(5,6,'INFO','Another user notice') RETURNING id,user_id`)).rows;
    const ownNewId = temporaryRows.find(row => row.user_id === 2).id;
    const otherUserId = temporaryRows.find(row => row.user_id === 6).id;
    const currentInbox = await notificationReads.getNotifications({ user_id: 2, company_id: 5 });
    check(currentInbox.data.map(row => row.id), [ownNewId], 'Only the current company and current user inbox rows are visible');
    check(currentInbox.unread_count, 1, 'Current company unread rows are counted normally');
    await notificationReads.markRead({ user_id: 2, company_id: 5, notification_id: oldNotification });
    check((await pool.query('SELECT is_read FROM notifications WHERE id=$1', [oldNotification])).rows[0].is_read,
      false, 'A current-company single read cannot change a historical foreign-company row');
    await notificationReads.markAllRead(2, 5);
    const readStates = (await pool.query('SELECT id,is_read FROM notifications WHERE id=ANY($1::bigint[]) ORDER BY id',
      [[oldNotification, ownNewId, otherUserId]])).rows;
    check(readStates.find(row => row.id === oldNotification).is_read, false, 'Mark-all-read preserves historical company rows');
    check(readStates.find(row => row.id === ownNewId).is_read, true, 'Mark-all-read marks the authenticated company row');
    check(readStates.find(row => row.id === otherUserId).is_read, false, 'Mark-all-read preserves another user rows');
    const unreadOnly = await notificationReads.getNotifications({ user_id: 2, company_id: 5, unread_only: 'true' });
    check(unreadOnly.data, [], 'Unread filtering stays inside the authenticated user and company');
    check(await notificationReads.getUnreadCount(2, 5), 0, 'The current company badge clears after reading');
    await pool.query('DELETE FROM notifications WHERE id=ANY($1::bigint[])', [temporaryRows.map(row => row.id)]);
    await pool.query('UPDATE users SET company_id=4,plant_id=8 WHERE id=2');
    check(await notificationReads.getUnreadCount(2, 4), 1, 'Historical alarms remain intact when the original company scope is restored');
    const rollbackClient = await pool.connect();
    try {
      await assert.rejects(() => rollbackClient.query(rollback), /Cannot roll back 047/); assertions++;
      await rollbackClient.query('ROLLBACK');
    } finally { rollbackClient.release(); }
    check(await count(), 3, 'Rollback preserves existing inbox history');
    check((await pool.query('SELECT COUNT(*)::int AS count FROM machine_alarms')).rows[0].count, 1, 'Rollback preserves alarm history');
    check((await pool.query('SELECT COUNT(*)::int AS count FROM alarm_notification_rules')).rows[0].count, 1, 'Refused rollback preserves company configuration');

    console.log(`Alarm notification PostgreSQL fixture passed (${assertions} assertions): migration/reapply/rollback, 30-second and ten-minute confirmed thresholds, transient clear, recurrence, concurrent exactly-once inbox, tenant/plant/permission/personal preferences, stale/future/queued/offline protection, cold-start reconciliation and journal replay, enable/change reset, transactional failure retry, socket durability, rule validation, scoped reads and company reassignment inbox isolation.`);
  } finally {
    if (pool) await pool.end();
    if (running) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
