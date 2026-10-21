#!/usr/bin/env node
/* Disposable real PostgreSQL + HTTP gateway contract verification.
 * Never reads application .env, connects to a controller or configured services.
 */
Object.assign(process.env, {NODE_ENV:'test',CRON_ENABLED:'false',REDIS_URL:'redis://127.0.0.1:1',POSTGRESQL_HOST:'127.0.0.1',POSTGRESQL_PORT:'1',POSTGRESQL_USER:'fixture',POSTGRESQL_PASSWORD:'fixture',POSTGRESQL_DATABASE:'fixture',EMAIL_USER:'',EMAIL_PASS:''});
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const express = require('express');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mexa-gateway-pg-'));
const bin = process.env.TEST_PG_BIN || '/opt/homebrew/bin';
const repository = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(repository, 'src/migrations', name), 'utf8');
const pg = (name, args) => execFileSync(path.join(bin, name), args, { stdio: 'pipe' });
let pool, server, started = false, assertions = 0;
const watchdog = setTimeout(() => {
  console.error('Gateway fixture timed out; unfinished work is not a pass.');
  try { if (started) pg('pg_ctl', ['-D',path.join(root,'cluster'),'-m','immediate','-w','stop']); } catch {}
  fs.rmSync(root,{recursive:true,force:true}); process.exit(1);
},60000);
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const rejects = async (work, code) => { await assert.rejects(work, error => error.code === code); assertions++; };
function inject(relative, value) {
  const filename = require.resolve(path.join(repository, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: value };
}
const schema = `
CREATE TABLE companies(id INT PRIMARY KEY,name TEXT,is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE plants(id INT PRIMARY KEY,company_id INT REFERENCES companies,plant_name TEXT,is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE users(id INT PRIMARY KEY,company_id INT,username TEXT,plant_id INT,is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE roles(id INT PRIMARY KEY,company_id INT,role_name TEXT);
CREATE TABLE user_roles(user_id INT,role_id INT);
CREATE TABLE role_permissions(role_id INT,permission_id INT);
CREATE TABLE machines(id INT PRIMARY KEY,company_id INT REFERENCES companies,plant_id INT REFERENCES plants,
 machine_serial_no TEXT,ip_address TEXT,controller_ip TEXT,program_path TEXT,is_active BOOLEAN DEFAULT TRUE);
CREATE TABLE program_devices(id SERIAL PRIMARY KEY,company_id INT,machine_id INT,label TEXT,token_hash TEXT,
 last_seen_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ,revoked_by INT);
CREATE TABLE program_files(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,folder TEXT,stored_name TEXT,
 program_name TEXT,kind TEXT,size_bytes BIGINT,sha256 TEXT,uploaded_by INT,note TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),
 deleted_at TIMESTAMPTZ,deleted_by INT,device_id INT,job_id BIGINT);
CREATE TABLE program_jobs(id BIGSERIAL PRIMARY KEY,company_id INT,machine_id INT,machine_serial TEXT,
 action VARCHAR(10) CHECK(action IN('SEND','FETCH')),program_name TEXT NOT NULL,file_id BIGINT,backup_file_id BIGINT,
 overwrite BOOLEAN DEFAULT FALSE,status TEXT DEFAULT 'QUEUED',message TEXT,requested_by INT,device_id INT,
 requested_at TIMESTAMPTZ DEFAULT NOW(),delivered_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,program_path TEXT);
CREATE TABLE program_controller_files(machine_id INT PRIMARY KEY,files JSONB);
CREATE TABLE notification_preferences(user_id INT PRIMARY KEY,notify_program_transfer BOOLEAN DEFAULT TRUE);
CREATE TABLE notifications(id BIGSERIAL PRIMARY KEY,company_id INT,user_id INT,type TEXT,title TEXT,message TEXT,link TEXT);
CREATE TABLE permissions(id SERIAL PRIMARY KEY,permission_key TEXT UNIQUE);
CREATE TABLE company_permissions(company_id INT,permission_id INT REFERENCES permissions);
INSERT INTO companies VALUES(1,'Fixture company',TRUE),(2,'Foreign company',TRUE);
INSERT INTO plants VALUES(10,1,'Plant A',TRUE),(11,1,'Plant B',TRUE),(20,2,'Foreign',TRUE);
INSERT INTO users(id,company_id,username) VALUES(1,1,'Fixture administrator'),(2,2,'Foreign administrator');
INSERT INTO roles VALUES(1,NULL,'COMPANY_ADMIN');
INSERT INTO user_roles VALUES(1,1),(2,1);
INSERT INTO permissions(permission_key) VALUES('page:programs:view');
INSERT INTO machines(id,company_id,plant_id,machine_serial_no,program_path) VALUES
 (7,1,10,'CNC-7','/programs'),(8,2,20,'FOREIGN','/programs'),(9,1,10,'CNC-9','/programs'),
 (10,1,11,'CNC-10','/programs'),(11,1,10,'CNC-11','/programs');
INSERT INTO program_devices(company_id,machine_id,label) VALUES(1,7,'Old device');
`;
(async () => {
  try {
    pg('initdb', ['-D', path.join(root, 'cluster'), '-U', 'gateway_fixture', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    pg('pg_ctl', ['-D', path.join(root, 'cluster'), '-l', path.join(root, 'postgres.log'), '-o', `-h '' -k ${root} -p 55439`, '-w', 'start']);
    started = true;
    pool = new Pool({ host: root, port: 55439, database: 'postgres', user: 'gateway_fixture', max: 12 });
    await pool.query(schema);
    for (const migration of ['039_program_current.sql','040_program_commands.sql','041_program_tenant_integrity.sql']) await pool.query(read(migration));
    await pool.query(read('049_gateway_transfer.sql'));
    await pool.query(read('049_gateway_transfer.sql'));
    check((await pool.query("SELECT to_regclass('program_gateway_events') AS name")).rows[0].name, 'program_gateway_events', 'Migration replays without losing schema');
    await pool.query(read('rollback/049_gateway_transfer_down.sql'));
    await pool.query(read('rollback/049_gateway_transfer_down.sql'));
    check((await pool.query('SELECT COUNT(*)::int AS n FROM machines')).rows[0].n, 5, 'Empty rollback is repeatable and preserves machines');
    await pool.query(read('049_gateway_transfer.sql'));
    process.env.STORAGE_ROOT = path.join(root, 'files');
    process.env.PROGRAM_TRANSFER_DIR = path.join(root, 'legacy');
    const emissions = [];
    inject('src/db.js', pool);
    inject('src/redis.js', {get:async()=>null,set:async()=>{},del:async()=>{}});
    inject('src/lib/realtime.js', { emitToUser: (id, name, body) => emissions.push({ id, name, body }) });
    inject('src/notifications/notification.service.js', { announceUnread: async () => {} });
    const service = require('../../src/programs/gateway.service');
    const application = express(); application.use(express.json({limit:'1mb'}));
    application.use('/api/gateway/v1', require('../../src/programs/gateway.routes'));
    server = application.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const {createClient} = require('../gateway-client/client.cjs');
    const storage = require('../../src/programs/storage');
    const tokens = require('../../src/programs/gateway-token');
    const user = { id: 1, company_id: 1, roles: ['COMPANY_ADMIN'], plant_id: null, permissions: ['page:programs:view','page:programs:upload','page:programs:transfer','page:programs:fetch','page:programs:delete','page:machines:edit'] };
    const req = (body = {}, params = {}, key = 'fixture-request-00001') => ({ user, body, params, query: {}, headers: { 'idempotency-key': key } });
    const create = await service.createGateway(req({ name: 'Windows Node-RED', max_concurrency: 1, plant_id: 10 }));
    const gatewayId = create.gateway.id;
    const gateway = { id: gatewayId, company_id: 1, plant_id: 10, token_version: 1, max_concurrency: 1 };
    const spoolRoot = path.join(fs.realpathSync(root),'gateway-spool');
    const transport = createClient({origin,token:create.token,spoolRoot});
    const unauthorized = await fetch(origin+'/api/gateway/v1/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    check(unauthorized.status,401,'Gateway API rejects missing credentials');
    check(create.token.startsWith('mxg_'), true, 'A gateway receives a distinct credential');
    check((await pool.query('SELECT token_hash FROM program_gateways WHERE id=$1',[gatewayId])).rows[0].token_hash, tokens.hash(create.token), 'Only the token hash is stored');
    await rejects(() => pool.query("INSERT INTO program_gateways(company_id,plant_id,name)VALUES(1,20,'Invalid')"), '23503');
    await service.saveAssignment(req({ gateway_id: gatewayId, protocol: 'ftp', controller_key: 'cnc7', program_path: '/programs' }, { machineId: 7 }));
    await service.saveAssignment(req({ gateway_id: gatewayId, protocol: 'ftp', controller_key: 'cnc9', program_path: '/programs' }, { machineId: 9 }));
    check((await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM program_devices WHERE machine_id=7')).rows[0].revoked, true, 'Assignment revokes the old per-machine writer token');
    await rejects(() => service.saveAssignment(req({ gateway_id: gatewayId, protocol: 'ftp', controller_key: 'foreign', program_path: '/programs' }, { machineId: 8 })), 'MACHINE_NOT_FOUND');
    await rejects(() => service.saveAssignment(req({ gateway_id: gatewayId, protocol: 'ftp', controller_key: 'other-plant', program_path: '/programs' }, { machineId: 10 })), 'PLANT_SCOPE');
    await rejects(() => pool.query("INSERT INTO program_jobs(company_id,machine_id,action,program_name,protocol_version)VALUES(1,7,'SEND','OLD.nc',2)"), '23514');
    await rejects(() => pool.query("INSERT INTO program_devices(company_id,machine_id,label)VALUES(1,7,'Unfenced legacy')"), '23514');
    const filename = path.join(root, 'upload.nc');
    const content = Buffer.from('%\nO1001\nG0 X0\nM30\n%\n');
    fs.writeFileSync(filename, content);
    const uploadRequest = key => ({ ...req({}, { machineId: 7 }, key), file: { path: filename, originalname: 'O1001.nc' } });
    const upload = await service.upload(uploadRequest('fixture-upload-00001'));
    const replay = await service.upload(uploadRequest('fixture-upload-00001'));
    check(upload.file.id, replay.file.id, 'Repeating a server upload reuses its immutable reference');
    const concurrentCopies=await Promise.all([service.upload(uploadRequest('concurrent-upload-01')),service.upload(uploadRequest('concurrent-upload-01'))]);
    check(concurrentCopies[0].file.id,concurrentCopies[1].file.id,'Concurrent duplicate uploads publish one logical reference');
    const alternate=path.join(root,'alternate.nc'); fs.writeFileSync(alternate,'M30\n');
    await rejects(()=>service.upload({...uploadRequest('fixture-upload-00001'),file:{path:alternate,originalname:'O1001.nc'}}),'REQUEST_CONFLICT');
    const largeName=path.join(root,'large.nc');
    const large=Buffer.from('G01 X12 Y34 F100\n'.repeat(400000)); fs.writeFileSync(largeName,large);
    const largeUpload=await service.upload({...req({}, {machineId:10},'large-offline-upload-01'),file:{path:largeName,originalname:'SURFACE.nc'}});
    check(Number(largeUpload.file.size_bytes),large.length,'Multi-megabyte reference upload completes through bounded disk streaming');
    check(largeUpload.file.sha256,storage.sha256(large),'Large streamed file metadata matches actual bytes');
    const copy = await storage.read(upload.file.folder, upload.file.stored_name);
    check(copy, content, 'Server bytes remain the exact reference content');
    const offlineUpload = await service.upload({ ...req({}, { machineId: 10 }, 'offline-upload-0001'), file: { path: filename, originalname: 'O1001.nc' } });
    check(offlineUpload.file.machine_id, 10, 'Server upload works before gateway assignment');
    await rejects(() => service.createCommand(req({ file_id: upload.file.id }, { machineId: 7 }), 'SEND'), 'CONFIRMATION_REQUIRED');
    await rejects(() => service.createCommand(req({ file_id: upload.file.id, confirm: true }, { machineId: 7 }), 'SEND'), 'UNSUPPORTED_CAPABILITY');
    // The remainder exercises the real gateway HTTP contract once mounted.
    const reports = { machines: [7,9].map(machine => ({ id: machine, configuration_version: 1, capabilities: { list: true, upload: true, download: true, current_backup: true, restore: true }, limitations: [] })) };
    const manifest = await transport.config(reports.machines);
    check(manifest.machines.map(m=>m.id),[7,9],'Windows gateway sees only its assigned machines through HTTP');
    const jobRequest = req({ file_id: upload.file.id, confirm: true }, { machineId: 7 }, 'fixture-send-000001');
    const queued = await service.createCommand(jobRequest, 'SEND');
    check((await service.createCommand(jobRequest, 'SEND')).job.id, queued.job.id, 'Duplicate command request reuses the same job');
    await rejects(() => service.saveAssignment(req({ gateway_id: gatewayId, protocol: 'ftp', controller_key: 'new-key', program_path: '/programs' }, { machineId: 7 })), 'COMMAND_PENDING');
    const claim = await transport.next({ available_slots: 1, active_job_ids: [], wait_seconds: 0 });
    const claimed = claim.job || claim.jobs?.[0];
    check(claimed.id, Number(queued.job.id), 'Assigned gateway claims its command');
    check(typeof claimed.lease_token, 'string', 'Gateway claim includes a private lease');
    const lease = claimed.lease_token;
    await rejects(() => service.result(gateway, claimed.id, { lease_token: lease, status: 'DONE' }), 'WRITE_NOT_VERIFIED');
    await rejects(() => service.jobFile(gateway, claimed.id, 'wrong-lease'), 'LEASE_INVALID');
    const source = await service.jobFile(gateway, claimed.id, lease);
    check((source.file || source).sha256, upload.file.sha256, 'Gateway download is bound to the exact queued file');
    const downloaded = await transport.download(claimed);
    check(await fs.promises.readFile(path.join(spoolRoot,downloaded.filename)),content,'Real HTTP download streams exact reference bytes to gateway spool');
    await transport.progress(claimed,{stage:'VERIFYING',bytes:content.length,total:content.length});
    await transport.result(claimed,{status:'DONE',verified:true,safety_checked:true,sha256:upload.file.sha256,replaced:false});
    check((await service.status(req({}, { machineId: 7 }))).jobs[0].status, 'DONE', 'Controller verification completes the server command');
    await transport.result(claimed,{status:'DONE',verified:true,safety_checked:true,sha256:upload.file.sha256,replaced:false});
    const backupRequest = req({}, {machineId:7}, 'actual-current-backup-01');
    const backup = await service.createCommand(backupRequest,'BACKUP');
    const backupJob = (await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    check(backupJob.source,'CURRENT_RUNNING','Current backup explicitly asks embedded reader for actual controller program');
    await rejects(()=>service.result(gateway,backupJob.id,{lease_token:backupJob.lease_token,status:'DONE'}),'CAPTURE_REQUIRED');
    const currentBytes=Buffer.from('%\nO2002\nG1 X12\nM30\n%\n');
    await fs.promises.writeFile(path.join(spoolRoot,'controller-current.nc'),currentBytes);
    await assert.rejects(()=>transport.capture(backupJob,{filename:'controller-current.nc',program_name:'O2002.nc',type:'CURRENT'}),/identify and verify/); assertions++;
    const capture=await transport.capture(backupJob,{filename:'controller-current.nc',program_name:'O2002.nc',type:'CURRENT',current_program_verified:true,controller_reported_name:'O2002.nc'});
    check(capture.job.status,'DONE','Actual verified machine capture completes backup');
    check(await storage.read(capture.file.folder,capture.file.stored_name),currentBytes,'Backup stores actual controller bytes, distinct from uploaded reference');
    check(capture.file.sha256===upload.file.sha256,false,'Backup does not substitute the previous uploaded file');
    const repeatedCapture=await transport.capture(backupJob,{filename:'controller-current.nc',program_name:'O2002.nc',type:'CURRENT',current_program_verified:true,controller_reported_name:'O2002.nc'});
    check(repeatedCapture.file.id,capture.file.id,'Lost capture response retries keep one immutable backup version');
    check((await service.createCommand(backupRequest,'BACKUP')).job.id,backup.job.id,'Completed backup idempotency survives captured file metadata');
    const another=await service.createCommand(req({}, {machineId:7}, 'actual-current-backup-02'),'BACKUP');
    const anotherJob=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    const nextCapture=await transport.capture(anotherJob,{filename:'controller-current.nc',program_name:'O2002.nc',type:'CURRENT',current_program_verified:true,controller_reported_name:'O2002.nc'});
    check(nextCapture.file.id!==capture.file.id,true,'Each separate backup click creates a new version');
    check(another.job.id!==backup.job.id,true,'Separate clicks have independent command history');
    const restoration=await service.createCommand(req({file_id:capture.file.id,confirm:true},{machineId:7},'verified-restore-001'),'RESTORE');
    const restoreJob=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    check(restoreJob.action,'RESTORE','Saved backup restoration is a new authorized controller command');
    await transport.download(restoreJob);
    await transport.result(restoreJob,{status:'DONE',verified:true,safety_checked:true,sha256:capture.file.sha256,replaced:false});
    check((await service.status(req({}, {machineId:7}))).jobs[0].id,restoration.job.id,'Restore history is separate from backup capture');
    const browsing=await service.createCommand(req({path:'subfolder'},{machineId:7},'browse-subfolder-001'),'LIST');
    const browseJob=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    const notificationCount=(await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n;
    await transport.result(browseJob,{status:'DONE',path:'subfolder',listing:[{name:'O3003.nc',is_directory:false,size:7,modified:null}]});
    check((await service.status(req({}, {machineId:7}))).jobs[0].result_json.files[0].name,'O3003.nc','Remote listing returns the requested controller directory');
    check((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n,notificationCount,'Browsing does not create inbox noise');
    const fetching=await service.createCommand(req({path:'subfolder/O3003.nc'},{machineId:7},'fetch-subfolder-0001'),'FETCH');
    const fetchJob=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    check(fetchJob.relative_path,'subfolder','Controller retrieval is scoped to the selected subdirectory');
    const fetched=await transport.capture(fetchJob,{filename:'controller-current.nc',program_name:'O3003.nc',type:'FETCHED'});
    check(fetched.file.kind,'FETCHED','Selected remote files are captured separately from running backups');
    check(fetching.job.id,fetched.job.id,'Capture is linked to its exact requested file job');
    const active=await service.createCommand(req({file_id:upload.file.id,confirm:true},{machineId:7},'uncertain-write-0001'),'SEND');
    const activeJob=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    const uncertain=await transport.result(activeJob,{status:'FAILED',error_code:'NETWORK_LOST',message:'Controller reply was lost.',write_started:true});
    check(uncertain.job.stage,'NEEDS_RECONCILIATION','Uncertain write remains fenced for gateway reconciliation');
    await rejects(()=>service.retry(req({confirm:true},{id:active.job.id},'unsafe-write-retry-01')),'JOB_NOT_OPEN');
    await transport.result(activeJob,{status:'FAILED',error_code:'WRITE_RECONCILED',message:'Controller content differs; embedded team confirmed the observed state.',write_started:true,reconciled:true,verified:true});
    const pending=await service.createCommand(req({file_id:upload.file.id,confirm:true},{machineId:7},'queued-cancel-000001'),'SEND');
    check((await service.cancel(req({}, {id:pending.job.id}))).status,'CANCELLED','Queued work can be cancelled without pretending to stop a controller');
    const queuedFirst=await service.createCommand(req({}, {machineId:7},'capacity-read-first-01'),'BACKUP');
    const queuedSecond=await service.createCommand(req({}, {machineId:9},'capacity-read-second-01'),'BACKUP');
    const duplicateClaims=await Promise.all([transport.next({available_slots:1,active_job_ids:[],wait_seconds:0}),transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})]);
    const occupied=duplicateClaims[0].job;
    check(duplicateClaims[1].job.id,occupied.id,'Concurrent reconnect claims recover the same command rather than dispatch another');
    check(duplicateClaims[1].job.lease_token,occupied.lease_token,'Reconnect preserves the private command lease');
    check((await transport.next({available_slots:1,active_job_ids:[occupied.id],wait_seconds:0})).job,null,'Shared-gateway concurrency capacity is enforced across machines');
    await rejects(()=>service.rotateGateway(req({}, {gatewayId})),'COMMAND_PENDING');
    const dedicated=await service.createGateway(req({name:'Dedicated Windows gateway',plant_id:10,max_concurrency:1}));
    await service.saveAssignment(req({gateway_id:dedicated.gateway.id,protocol:'focas',controller_key:'cnc11',program_path:'/programs'},{machineId:11}));
    const transport2=createClient({origin,token:dedicated.token,spoolRoot:path.join(fs.realpathSync(root),'dedicated-spool')});
    await transport2.config([{id:11,configuration_version:1,capabilities:{list:true,upload:true,download:true,current_backup:true,restore:true},limitations:[]}]);
    await service.createCommand(req({}, {machineId:11},'dedicated-backup-01'),'BACKUP');
    const independent=(await transport2.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    check(independent.machine_id,11,'A dedicated gateway can run independently of a busy shared gateway');
    const stolen=await fetch(origin+`/api/gateway/v1/jobs/${occupied.id}/result`,{method:'POST',headers:{Authorization:'Bearer '+dedicated.token,'Content-Type':'application/json'},body:JSON.stringify({lease_token:occupied.lease_token,status:'FAILED',error_code:'FAKE',message:'Foreign gateway attempt.',write_started:false})});
    check(stolen.status,404,'Another authenticated gateway cannot report a foreign machine command');
    await transport2.result(independent,{status:'FAILED',error_code:'CONTROLLER_OFFLINE',message:'Fixture controller intentionally unavailable.',write_started:false});
    await transport.result(occupied,{status:'FAILED',error_code:'CONTROLLER_OFFLINE',message:'Fixture controller intentionally unavailable.',write_started:false});
    const following=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    check([Number(queuedFirst.job.id),Number(queuedSecond.job.id)].includes(following.id),true,'Shared queue continues after the previous machine releases capacity');
    check(following.id!==occupied.id,true,'Different machine receives its own command after capacity releases');
    await transport.result(following,{status:'FAILED',error_code:'CONTROLLER_OFFLINE',message:'Fixture controller intentionally unavailable.',write_started:false});
    await rejects(()=>service.status({...req({}, {machineId:7}),user:{...user,roles:['ENGINEER'],plant_id:11}}),'MACHINE_NOT_FOUND');
    const observerBefore=emissions.length;
    const reassigned=await service.createCommand(req({}, {machineId:7},'recipient-recheck-01'),'BACKUP');
    const recipientJob=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    await pool.query('UPDATE users SET company_id=2 WHERE id=1');
    const afterReassign=emissions.length;
    await transport.result(recipientJob,{status:'FAILED',error_code:'CONTROLLER_OFFLINE',message:'Completed after requester moved company.',write_started:false});
    check(emissions.length,afterReassign,'Company reassignment prevents later transfer socket disclosure');
    check((await pool.query('SELECT status FROM program_jobs WHERE id=$1',[reassigned.job.id])).rows[0].status,'FAILED','Recipient revocation cannot undo the durable controller result');
    await pool.query('UPDATE users SET company_id=1 WHERE id=1');
    const expiresQueued=await service.createCommand(req({}, {machineId:7},'expired-queued-01'),'BACKUP');
    await pool.query("UPDATE program_jobs SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[expiresQueued.job.id]);
    check(await service.expireStale({gatewayId}),1,'Uncollected command expiry is swept once');
    check((await pool.query('SELECT status,error_code FROM program_jobs WHERE id=$1',[expiresQueued.job.id])).rows[0],{status:'FAILED',error_code:'QUEUE_TIMEOUT'},'Queue timeout releases an uncollected command');
    await service.createCommand(req({}, {machineId:7},'expired-read-0001'),'BACKUP');
    const expiresRead=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    await pool.query("UPDATE program_jobs SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[expiresRead.id]);
    check(await service.expireStale({gatewayId}),1,'A missing read response is collected by timeout');
    check((await pool.query('SELECT status,error_code FROM program_jobs WHERE id=$1',[expiresRead.id])).rows[0],{status:'FAILED',error_code:'GATEWAY_TIMEOUT'},'Expired read is failed without claiming a controller write');
    await service.createCommand(req({file_id:upload.file.id,confirm:true},{machineId:7},'expired-write-0001'),'SEND');
    const expiresWrite=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    await pool.query("UPDATE program_jobs SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[expiresWrite.id]);
    check(await service.expireStale({gatewayId}),1,'Expired physical write requires reconciliation');
    check(await service.expireStale({gatewayId}),0,'Repeated timeout sweep does not duplicate uncertain-write audit');
    const recoveredWrite=(await transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})).job;
    check(recoveredWrite.recovery_only,true,'Expired write is returned only for reconciliation');
    check(recoveredWrite.id,expiresWrite.id,'Expired write retains original ownership');
    const unsafeClosure=await transport.result(recoveredWrite,{status:'FAILED',error_code:'UNCONFIRMED',message:'No controller proof available.',write_started:false});
    check(unsafeClosure.job.status,'DELIVERED','A stale write cannot be released by claiming it never started');
    await transport.result(recoveredWrite,{status:'FAILED',error_code:'RECONCILED',message:'Embedded adapter verified final controller state.',verified:true,reconciled:true});
    const racing=await service.createCommand(req({}, {machineId:7},'cancel-claim-race-01'),'BACKUP');
    const race=await Promise.allSettled([service.cancel(req({}, {id:racing.job.id})),transport.next({available_slots:1,active_job_ids:[],wait_seconds:0})]);
    check(race.every(result=>result.status==='fulfilled'||result.reason.code==='JOB_NOT_OPEN'),true,'Concurrent cancel and claim settle without lock-order deadlock');
    const racedRow=(await pool.query('SELECT status FROM program_jobs WHERE id=$1',[racing.job.id])).rows[0];
    check(['CANCELLED','DELIVERED'].includes(racedRow.status),true,'Concurrent cancellation leaves one authoritative state');
    if(racedRow.status==='DELIVERED') await transport.result(race[1].value.job,{status:'FAILED',error_code:'CONTROLLER_OFFLINE',message:'Fixture ended before controller work.',write_started:false});
    const rotated=await service.rotateGateway(req({}, {gatewayId}));
    const oldTokenResponse=await fetch(origin+'/api/gateway/v1/config',{method:'POST',headers:{Authorization:'Bearer '+create.token,'Content-Type':'application/json'},body:'{}'});
    check(oldTokenResponse.status,401,'Rotated gateway credentials stop authorizing new requests');
    check(rotated.token!==create.token,true,'Rotation issues a new private credential');
    let failedCredentialStatus=0;
    for(let attempt=0;attempt<61&&failedCredentialStatus!==429;attempt++) {
      failedCredentialStatus=(await fetch(origin+'/api/gateway/v1/config',{method:'POST',headers:{Authorization:'Bearer invalid','Content-Type':'application/json'},body:'{}'})).status;
      assert.ok([401,429].includes(failedCredentialStatus));
    }
    check(failedCredentialStatus,429,'Repeated failed credentials are limited before gateway authentication');
    check(emissions.every(event => !JSON.stringify(event.body).includes(lease)), true, 'No operator socket event leaks gateway leases');
    check((await pool.query('SELECT COUNT(*)::int AS n FROM program_gateway_events')).rows[0].n > 5, true, 'New work has durable audit history');
    const rollbackClient=await pool.connect();
    try { await assert.rejects(()=>rollbackClient.query(read('rollback/049_gateway_transfer_down.sql')),/Cannot roll back 049/); assertions++; }
    finally { await rollbackClient.query('ROLLBACK'); rollbackClient.release(); }
    console.log(`Gateway PostgreSQL/HTTP fixture passed (${assertions} assertions).`);
  } finally {
    clearTimeout(watchdog);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool?.end();
    if (started) pg('pg_ctl', ['-D', path.join(root,'cluster'), '-m','immediate','-w','stop']);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
