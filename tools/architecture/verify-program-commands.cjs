/* Disposable Unix-socket-only PostgreSQL verification. No .env/configured services.
 * node tools/architecture/verify-program-commands.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-command-pg-'));
const socket = path.join(root, 'socket');
fs.mkdirSync(socket, { mode: 0o700 });
const bin = process.env.TEST_PG_BIN || '/opt/homebrew/bin';
const pg = (name, args) => {
  const p = spawnSync(path.join(bin, name), args, { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`${name}: ${p.stderr || p.stdout || p.error}`);
};
let started = false, pool;
async function main() {
  try {
    pg('initdb', ['-D', path.join(root, 'cluster'), '-A', 'trust', '-U', 'iot_fixture', '--no-locale', '-E', 'UTF8']);
    pg('pg_ctl', ['-D', path.join(root, 'cluster'), '-l', path.join(root, 'postgres.log'), '-o', `-h '' -k ${socket} -p 55437`, '-w', 'start']);
    started = true;
    pool = new Pool({ host: socket, port: 55437, user: 'iot_fixture', database: 'postgres', max: 8 });
    await pool.query(`
      CREATE TABLE companies(id int PRIMARY KEY);
      CREATE TABLE machines(id int PRIMARY KEY,company_id int REFERENCES companies(id),plant_id int,machine_serial_no text,ip_address text,controller_ip text,program_path text,is_active bool DEFAULT true);
      CREATE TABLE users(id int PRIMARY KEY,username text);
      CREATE TABLE program_devices(id int PRIMARY KEY,company_id int,machine_id int,label text,last_seen_at timestamptz,revoked_at timestamptz);
      CREATE TABLE program_files(id bigserial PRIMARY KEY,company_id int,machine_id int,folder text,stored_name text,program_name text,kind text,size_bytes int,sha256 text,uploaded_by int,note text,created_at timestamptz DEFAULT now(),deleted_at timestamptz,deleted_by int,device_id int,job_id bigint);
      CREATE TABLE program_jobs(id bigserial PRIMARY KEY,company_id int,machine_id int,machine_serial text,action varchar(10) CHECK(action IN ('SEND','FETCH')),program_name text NOT NULL,file_id bigint,backup_file_id bigint,overwrite bool DEFAULT false,status text DEFAULT 'QUEUED',message text,requested_by int,device_id int,requested_at timestamptz DEFAULT now(),delivered_at timestamptz,finished_at timestamptz,program_path text);
      CREATE TABLE program_controller_files(machine_id int PRIMARY KEY,files jsonb);
      INSERT INTO companies VALUES(1),(2);
      INSERT INTO users VALUES(1,'Operator');
      INSERT INTO machines VALUES(7,1,10,'CNC-7','192.168.1.7',NULL,'/programs',true),(8,2,20,'CNC-8','192.168.1.7',NULL,'/programs',true),(9,1,10,'UNCONFIGURED',NULL,NULL,NULL,true);
      INSERT INTO program_devices VALUES(1,1,7,'Device',now(),NULL),(2,2,8,'Other',now(),NULL);
    `);
    for (let pass = 0; pass < 2; pass++) for (const file of ['039_program_current.sql','040_program_commands.sql','041_program_tenant_integrity.sql']) {
      await pool.query(fs.readFileSync(path.join(__dirname, '../../src/migrations', file), 'utf8'));
    }
    process.env.PROGRAM_TRANSFER_DIR = path.join(root, 'files');
    process.env.STORAGE_ROOT = path.join(root, 'unified-files');
    const stub = (relative, exports) => {
      const filename = require.resolve(relative);
      require.cache[filename] = { id: filename, filename, loaded: true, exports };
    };
    stub('../../src/db', pool);
    stub('../../src/audit/audit.service', { log: () => {} });
    stub('../../src/lib/realtime', { emitToUser: () => {} });
    stub('../../src/notifications/notification.service', { announceUnread: async () => {} });
    const commands = require('../../src/programs/commands');
    const jobs = require('../../src/programs/jobs');
    jobs.announce = async () => {};
    const storage = require('../../src/programs/storage');
    const program = Buffer.from('%\nO1001\nG0 X0\nM30\n%');
    const user = { id: 1, company_id: 1, plant_id: 10, permissions: ['page:programs:upload','page:programs:transfer','page:programs:fetch'] };
    const req = (key, extra = {}) => ({ user, params: { machineId: 7 }, headers: { 'idempotency-key': key }, body: {}, file: { originalname: 'O1001.nc', buffer: program }, ...extra });
    const device = { id: 1, company_id: 1, machine: { id: 7, company_id: 1, machine_serial_no: 'CNC-7', ip_address: '192.168.1.7', program_path: '/programs' } };
    await assert.rejects(commands.transfer(req('missing-config-0001', { params: { machineId: 9 } })), { code: 'NO_MACHINE_IP' });
    await assert.rejects(commands.transfer(req('foreign-company-01', { params: { machineId: 8 } })), { code: 'MACHINE_NOT_FOUND' });
    await assert.rejects(commands.transfer(req('foreign-plant-0001', { user: { ...user, plant_id: 99 } })), { code: 'MACHINE_NOT_FOUND' });
    await assert.rejects(commands.transfer(req('permission-denied', { user: { ...user, permissions: [] } })), { code: 'FORBIDDEN' });
    await assert.rejects(commands.saveConnection(req('bad-ip-value-0001', { body: { ip_address: '999.1.2.3', program_path: '/programs' } })), { code: 'BAD_MACHINE_IP' });
    const copies = await Promise.all([commands.transfer(req('same-upload-key-001')), commands.transfer(req('same-upload-key-001'))]);
    assert.equal(copies[0].job.id, copies[1].job.id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM program_jobs')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM program_files')).rows[0].n, 1);
    await assert.rejects(commands.transfer(req('same-upload-key-001', { file: { originalname: 'O1001.nc', buffer: Buffer.from('M30') } })), { code: 'REQUEST_CONFLICT' });
    await assert.rejects(commands.backup(req('pending-backup-001')), { code: 'COMMAND_PENDING' });
    const deliveries = await Promise.all([commands.next(device), commands.next(device)]);
    assert.equal(deliveries[0].job.id, deliveries[1].job.id);
    assert.equal(deliveries[0].job.file.method, 'POST');
    const id = deliveries[0].job.id;
    await assert.rejects(commands.result(device, id, { status: 'DONE' }), { code: 'WRITE_NOT_VERIFIED' });
    await assert.rejects(commands.result({ ...device, company_id: 2, machine: { ...device.machine, id: 8 } }, id, { status: 'FAILED', message: 'fake' }), { code: 'JOB_NOT_FOUND' });
    const done = { status: 'DONE', verified: true, replaced: false, sha256: storage.sha256(program) };
    await commands.result(device, id, done);
    await commands.result(device, id, done);
    const replacement = await commands.transfer(req('replace-upload-key-01', { body: { overwrite: true } }));
    await commands.next(device);
    await assert.rejects(commands.result(device, replacement.job.id, { ...done, replaced: true }), { code: 'BACKUP_REQUIRED' });
    const previousProgram = Buffer.from('%\nO1001\nM30\n%');
    const previousBody = { job_id: replacement.job.id, program_name: 'O1001.nc', sha256: storage.sha256(previousProgram) };
    const replacementBackup = await commands.storeReplacementBackup(device, previousBody, { buffer: previousProgram });
    const backupRetry = await commands.storeReplacementBackup(device, previousBody, { buffer: previousProgram });
    assert.equal(replacementBackup.id, backupRetry.id);
    await commands.result(device, replacement.job.id, { ...done, replaced: true });
    const referenceId = (await pool.query('SELECT file_id FROM program_current WHERE machine_id=7')).rows[0].file_id;
    const backupBytes = Buffer.from('%\nO2002\nM30\n%');
    const b = await commands.backup(req('fresh-backup-00001'));
    assert.equal(b.job.program_name, null);
    const claimed = (await commands.next(device)).job;
    assert.equal(claimed.action, 'BACKUP');
    assert.equal(claimed.source, 'CURRENT_RUNNING');
    await assert.rejects(commands.result(device, claimed.id, { status: 'DONE' }), { code: 'NO_FILE' });
    const body = { job_id: claimed.id, program_name: 'O2002.nc', sha256: storage.sha256(backupBytes) };
    const firstBackup = await commands.storeBackup(device, body, { originalname: 'O2002.nc', buffer: backupBytes });
    const retried = await commands.storeBackup(device, body, { originalname: 'O2002.nc', buffer: backupBytes });
    assert.equal(firstBackup.id, retried.id);
    const nextBackup = await commands.backup(req('fresh-backup-00002'));
    await commands.next(device);
    const fresh = await commands.storeBackup(device, { ...body, job_id: nextBackup.job.id }, { originalname: 'O2002.nc', buffer: backupBytes });
    assert.notEqual(firstBackup.id, fresh.id);
    assert.equal((await pool.query('SELECT file_id FROM program_current WHERE machine_id=7')).rows[0].file_id, referenceId);
    const failure = await commands.transfer(req('device-path-fail-01'));
    await commands.next(device);
    await commands.result(device, failure.job.id, { status: 'FAILED', error_code: 'PATH_NOT_FOUND', message: 'The configured folder does not exist on the controller.' });
    assert.equal((await commands.status(req('view-status-0001'))).jobs.find(j => j.action === 'SEND').error_code, 'PATH_NOT_FOUND');
    const timeout = await commands.backup(req('timeout-backup-0001'));
    await pool.query("UPDATE program_jobs SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [timeout.job.id]);
    assert.equal((await commands.status(req('view-timeout-001'))).jobs.find(j => j.action === 'BACKUP').error_code, 'DEVICE_TIMEOUT');
    // A failed SQL write removes only the new upload bytes, never earlier references.
    await pool.query("CREATE FUNCTION reject_new_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_key='rollback-upload-001' THEN RAISE EXCEPTION 'injected rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_command BEFORE INSERT ON program_jobs FOR EACH ROW EXECUTE FUNCTION reject_new_command()");
    const uploadFolder = path.join(storage.ROOT, 'company-1/programs/machine-7/uploads');
    const before = fs.readdirSync(uploadFolder).sort();
    const rowsBefore = (await pool.query('SELECT count(*)::int n FROM program_files')).rows[0].n;
    await assert.rejects(commands.transfer(req('rollback-upload-001')), /injected rollback/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM program_files')).rows[0].n, rowsBefore);
    assert.deepEqual(fs.readdirSync(uploadFolder).sort(), before);
    await assert.rejects(pool.query('INSERT INTO program_current(company_id,machine_id,file_id) VALUES(2,8,$1)', [referenceId]), { code: '23503' });
    await pool.query(`
      CREATE TABLE shifts(id int PRIMARY KEY,company_id int,start_time time,end_time time);
      CREATE TABLE production_hourly(company_id int,machine_id int,shift_id int,hour_start timestamptz,run_seconds int,idle_seconds int,produced_qty int);
      CREATE TABLE machine_current_job(id serial PRIMARY KEY,company_id int,machine_id int,started_at timestamptz,ended_at timestamptz,cycle_time_seconds numeric);
      CREATE TABLE oee_shift_summary(machine_id int,shift_id int,shift_date date,availability numeric,performance numeric NOT NULL,quality numeric NOT NULL,oee numeric NOT NULL);
      CREATE TABLE oee_hourly(machine_id int,performance numeric NOT NULL,quality numeric NOT NULL,oee numeric NOT NULL);
      INSERT INTO shifts VALUES(5,1,'08:15','16:15');
      INSERT INTO production_hourly VALUES(1,7,5,'2026-10-13 08:00:00+05:30',600,1200,10),(1,7,5,'2026-10-13 09:00:00+05:30',1200,2400,20);
      INSERT INTO machine_current_job(company_id,machine_id,started_at,ended_at,cycle_time_seconds) VALUES
        (1,7,'2026-10-13 08:00:00+05:30','2026-10-13 09:00:00+05:30',30),
        (1,7,'2026-10-13 09:00:00+05:30','2026-10-13 10:00:00+05:30',60);
    `);
    await pool.query('INSERT INTO oee_shift_summary(machine_id,performance,quality,oee) VALUES(7,80,90,60),(999,70,80,50)');
    for (let pass=0;pass<2;pass++) await pool.query(fs.readFileSync(path.join(__dirname,'../../src/migrations/044_oee_measurement_integrity.sql'),'utf8'));
    const legacySummaries = (await pool.query('SELECT machine_id,company_id,performance FROM oee_shift_summary ORDER BY machine_id')).rows;
    assert.equal(legacySummaries[0].company_id, 1);
    assert.equal(Number(legacySummaries[0].performance), 80);
    assert.equal(legacySummaries[1].company_id, null);
    const historical = require('../../src/lib/historical-production');
    const hours = (await pool.query(historical.rowsSQL,[1,[7],5,'2026-10-13'])).rows;
    assert.equal(hours.length,2); // Includes the partial first clock-hour bucket.
    assert.equal(Number(hours[0].planned_seconds),2700);
    assert.deepEqual(historical.metrics(hours,3600,27),{availability:50,performance:83.33,quality:90,oee:37.5});
    await pool.query(`INSERT INTO machine_current_job(company_id,machine_id,started_at,ended_at,cycle_time_seconds) VALUES(1,7,'2026-10-13 09:30:00+05:30','2026-10-13 10:00:00+05:30',99)`);
    const ambiguous = (await pool.query(historical.rowsSQL,[1,[7],5,'2026-10-13'])).rows;
    assert.equal(ambiguous[1].cycle_time_seconds,null);
    assert.equal(historical.metrics(ambiguous,3600,27).performance,null);
    await pool.query('INSERT INTO oee_shift_summary(machine_id,performance,quality,oee,company_id) VALUES(7,NULL,NULL,NULL,1)');
    console.log('PASS PostgreSQL: historical snapshot weighting, partial shift buckets, ambiguous jobs remain NULL, 044 applied twice');
    console.log('PASS PostgreSQL: migrations twice, tenant/plant guards, one concurrent operation, idempotent upload/claim/results/backup, fresh backup per click, saved reference retained, device errors/timeouts, rollback bytes, composite ownership FK');
  } finally {
    if (pool) await pool.end();
    if (started) pg('pg_ctl', ['-D', path.join(root, 'cluster'), '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
