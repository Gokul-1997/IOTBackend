/* Durable Program Transfer operations. MQTT telemetry remains independent.
 * A device can collect every command through outbound HTTPS POST requests.
 */
const pool = require('../db');
const net = require('node:net');
const crypto = require('node:crypto');
const storage = require('./storage');
const jobs = require('./jobs');
const audit = require('../audit/audit.service');
const { cleanProgramPath, targetFile } = require('./program-path');
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const one = result => result.rows[0];
const OPEN = ['QUEUED', 'DELIVERED'];
const allowed = (user, permission) => user?.is_snt_super || user?.permissions?.includes(permission);
function requireConfig(machine) {
  if (!net.isIP(String(machine.ip_address || ''))) throw fail('Save the machine IP address in Program Transfer first.', 'NO_MACHINE_IP', 409);
  if (!cleanProgramPath(machine.program_path)) throw fail('Save the machine program path in Program Transfer first.', 'NO_PROGRAM_PATH', 409);
}
function requestKey(req) {
  const key = req.headers?.['idempotency-key'];
  if (key == null) return crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(key))) throw fail('Idempotency-Key must contain 16–80 letters, digits, hyphens or underscores.', 'BAD_REQUEST_KEY');
  return String(key);
}
async function machineFor(db, machineId, user, lock = false) {
  const id = Number(machineId);
  if (!Number.isInteger(id) || id <= 0) throw fail('Choose a machine.', 'NO_MACHINE');
  const machine = one(await db.query(`SELECT id, company_id, plant_id, machine_serial_no, ip_address, controller_ip, program_path
    FROM machines WHERE id=$1 AND company_id=$2 AND is_active=true AND ($3::int IS NULL OR plant_id=$3) ${lock ? 'FOR UPDATE' : ''}`,
  [id, user.company_id, user.plant_id || null]));
  if (!machine) throw fail('Machine not found in your company and plant.', 'MACHINE_NOT_FOUND', 404);
  return machine;
}
async function expire(db, machineId) {
  return db.query(`UPDATE program_jobs SET status='FAILED', finished_at=NOW(), error_code='DEVICE_TIMEOUT',
    message=CASE status WHEN 'QUEUED' THEN 'The device did not collect the command within 5 minutes. Check the device connection and command support.'
      ELSE 'The device did not confirm completion. Check the controller before retrying a transfer.' END
    WHERE machine_id=$1 AND protocol_version=2 AND status=ANY($2) AND expires_at<=NOW() RETURNING id`, [machineId, OPEN]);
}
async function announce(job) {
  await jobs.announce(job).catch(error => console.error('[program command notification]', error.message));
}
async function savedFile(db, id, companyId) {
  return one(await db.query(`SELECT id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256, created_at
    FROM program_files WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`, [id, companyId]));
}
exports.saveConnection = async req => {
  const ip = String(req.body?.ip_address || '').trim();
  if (!net.isIP(ip)) throw fail('Enter a valid IPv4 or IPv6 machine address.', 'BAD_MACHINE_IP');
  const programPath = cleanProgramPath(req.body?.program_path);
  if (!programPath) throw fail('Enter the machine program folder.', 'BAD_PROGRAM_PATH');
  const client = await pool.connect();
  let machine;
  try {
    await client.query('BEGIN');
    machine = await machineFor(client, req.params.machineId, req.user, true);
    const open = await client.query('SELECT id FROM program_jobs WHERE machine_id=$1 AND status=ANY($2) LIMIT 1', [machine.id, OPEN]);
    if (open.rows.length) throw fail('Finish or cancel the pending operation before changing its connection.', 'COMMAND_PENDING', 409);
    await client.query('UPDATE machines SET ip_address=$1, program_path=$2 WHERE id=$3 AND company_id=$4', [ip, programPath, machine.id, req.user.company_id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  audit.log({ user_id: req.user.id, company_id: machine.company_id, action: 'PROGRAM_CONNECTION_SAVE', resource: 'machine', resource_id: machine.id,
    new_value: { ip_address: ip, program_path: programPath }, ip_address: req.ip, user_agent: req.headers?.['user-agent'] });
  return { machine: { id: machine.id, ip_address: ip, program_path: programPath } };
};

async function create(req, action) {
  const permission = action === 'SEND' ? 'page:programs:transfer' : 'page:programs:fetch';
  if (!allowed(req.user, permission) || (action === 'SEND' && !allowed(req.user, 'page:programs:upload'))) throw fail('This operation is not part of your role.', 'FORBIDDEN', 403);
  if (action === 'SEND' && !req.file) throw fail('Choose a program file.', 'NO_FILE');
  const key = requestKey(req);
  const overwrite = req.body?.overwrite === true || req.body?.overwrite === 'true';
  const name = action === 'SEND' ? storage.safeProgramName(req.body?.program_name || req.file.originalname) : null;
  const checksum = action === 'SEND' ? storage.sha256(req.file.buffer) : null;
  if (action === 'SEND') storage.checkContent(req.file.buffer);
  const client = await pool.connect();
  let saved, file, job, committing = false;
  const expired = [];
  try {
    await client.query('BEGIN');
    const machine = await machineFor(client, req.params.machineId, req.user, true);
    const previous = one(await client.query(`SELECT id FROM program_jobs WHERE company_id=$1 AND machine_id=$2 AND requested_by=$3 AND request_key=$4`, [machine.company_id, machine.id, req.user.id, key]));
    if (previous) {
      job = await jobs.getJob(previous.id, client);
      if (job.action !== action || (action === 'SEND' && (job.program_name !== name || job.file_sha256 !== checksum || job.overwrite !== overwrite))) throw fail('This request key was already used for a different operation.', 'REQUEST_CONFLICT', 409);
      file = job.file_id ? await savedFile(client, job.file_id, machine.company_id) : null;
      await client.query('COMMIT');
      return { ...(action === 'SEND' ? { file } : {}), job: jobs.view(job) };
    }
    requireConfig(machine);
    const device = one(await client.query('SELECT id FROM program_devices WHERE machine_id=$1 AND company_id=$2 AND revoked_at IS NULL', [machine.id, machine.company_id]));
    if (!device) throw fail('Create and configure this machine’s device token first.', 'NO_DEVICE', 409);
    expired.push(...(await expire(client, machine.id)).rows);
    const active = await client.query('SELECT id FROM program_jobs WHERE machine_id=$1 AND status=ANY($2) LIMIT 1', [machine.id, OPEN]);
    if (active.rows.length) throw fail('This machine already has an operation pending. Wait for its result.', 'COMMAND_PENDING', 409);
    if (action === 'SEND') {
      const inventory = one(await client.query('SELECT files FROM program_controller_files WHERE machine_id=$1', [machine.id]));
      const normalize = value => String(value || '').toLowerCase().replace(/\.[^.]+$/, '');
      if (!overwrite && inventory?.files?.some(f => normalize(f.name) === normalize(name))) throw fail('This program already exists on the controller. Confirm replacement explicitly.', 'FILE_EXISTS', 409);
      saved = await storage.save({ machine, kind: 'NEW', programName: name, buffer: req.file.buffer });
      file = one(await client.query(`INSERT INTO program_files(company_id,machine_id,folder,stored_name,program_name,kind,size_bytes,sha256,uploaded_by,note)
        VALUES($1,$2,$3,$4,$5,'NEW',$6,$7,$8,$9) RETURNING id,machine_id,folder,stored_name,program_name,kind,size_bytes,sha256,created_at`,
      [machine.company_id, machine.id, saved.folder, saved.storedName, name, saved.size, saved.sha256, req.user.id, req.body?.note ? String(req.body.note).slice(0, 255) : null]));
      await client.query(`INSERT INTO program_current(company_id,machine_id,file_id) VALUES($1,$2,$3)
        ON CONFLICT(machine_id) DO UPDATE SET company_id=EXCLUDED.company_id,file_id=EXCLUDED.file_id,updated_at=NOW()`, [machine.company_id, machine.id, file.id]);
    }
    const inserted = one(await client.query(`INSERT INTO program_jobs(company_id,machine_id,machine_serial,action,program_name,file_id,overwrite,requested_by,program_path,controller_ip,protocol_version,request_key,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,$11,NOW()+INTERVAL '5 minutes') RETURNING id`,
    [machine.company_id, machine.id, machine.machine_serial_no, action, name, file?.id || null, overwrite, req.user.id, machine.program_path, machine.ip_address, key]));
    job = await jobs.getJob(inserted.id, client);
    committing = true;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (saved && !committing) await storage.remove(saved.folder, saved.storedName).catch(() => {});
    throw error;
  } finally { client.release(); }
  for (const row of expired) await announce(await jobs.getJob(row.id));
  await announce(job);
  audit.log({ user_id: req.user.id, company_id: req.user.company_id, action: action === 'SEND' ? 'PROGRAM_TRANSFER_REQUEST' : 'PROGRAM_BACKUP_REQUEST', resource: 'program_job', resource_id: job.id,
    new_value: { machine_id: job.machine_id, program_name: name, overwrite }, ip_address: req.ip, user_agent: req.headers?.['user-agent'] });
  return { ...(action === 'SEND' ? { file: { ...file, is_current: true } } : {}), job: jobs.view(job) };
}
exports.transfer = req => create(req, 'SEND');
exports.backup = req => create(req, 'BACKUP');
exports.requireConfig = requireConfig;
exports.expire = expire;

function deviceView(job) {
  return { id: Number(job.id), action: job.action, source: job.action === 'BACKUP' ? 'CURRENT_RUNNING' : null,
    program_name: job.program_name, program_path: job.program_path, ip_address: job.controller_ip,
    target_file: job.program_name ? targetFile(job.program_path, job.program_name) : null,
    overwrite: job.overwrite, expires_at: job.expires_at,
    file: job.action === 'SEND' ? { size: job.file_size, sha256: job.file_sha256, method: 'POST', url: `/api/device/v1/jobs/${job.id}/file` } : null };
}
exports.next = async device => {
  const client = await pool.connect();
  let job;
  const expired = [];
  try {
    await client.query('BEGIN');
    const machine = one(await client.query('SELECT id FROM machines WHERE id=$1 AND company_id=$2 AND is_active=true FOR UPDATE', [device.machine.id, device.company_id]));
    if (!machine) throw fail('Machine unavailable.', 'MACHINE_INACTIVE', 403);
    expired.push(...(await expire(client, machine.id)).rows);
    const active = one(await client.query(`SELECT id,device_id,protocol_version FROM program_jobs WHERE machine_id=$1 AND company_id=$2 AND status='DELIVERED' ORDER BY delivered_at,id LIMIT 1`, [machine.id, device.company_id]));
    if (active) {
      if (active.protocol_version !== 2 || active.device_id !== device.id) throw fail('Another controller operation is active. Check its result before continuing.', 'CONTROLLER_BUSY', 409);
      job = await jobs.getJob(active.id, client);
    } else {
      const claimed = one(await client.query(`UPDATE program_jobs SET status='DELIVERED',delivered_at=NOW(),device_id=$3,expires_at=NOW()+INTERVAL '15 minutes'
        WHERE id=(SELECT id FROM program_jobs WHERE machine_id=$1 AND company_id=$2 AND protocol_version=2 AND status='QUEUED'
        ORDER BY requested_at,id LIMIT 1 FOR UPDATE) RETURNING id`, [machine.id, device.company_id, device.id]));
      if (claimed) job = await jobs.getJob(claimed.id, client);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  for (const row of expired) await announce(await jobs.getJob(row.id));
  if (job) await announce(job);
  return { job: job ? deviceView(job) : null, poll_seconds: 15,
    machine: { id: device.machine.id, serial: device.machine.machine_serial_no, ip_address: device.machine.ip_address, program_path: device.machine.program_path } };
};

exports.status = async req => {
  const machine = await machineFor(pool, req.params.machineId, req.user);
  const expired = (await expire(pool, machine.id)).rows;
  for (const row of expired) await announce(await jobs.getJob(row.id));
  const [current, backup, latest, device] = await Promise.all([
    pool.query(`SELECT f.id,f.machine_id,f.program_name,f.kind,f.size_bytes,f.sha256,f.created_at,true AS is_current FROM program_current c
      JOIN program_files f ON f.id=c.file_id AND f.machine_id=c.machine_id AND f.company_id=c.company_id
      WHERE c.company_id=$1 AND c.machine_id=$2 AND f.deleted_at IS NULL`, [machine.company_id, machine.id]),
    pool.query(`SELECT id,machine_id,program_name,kind,size_bytes,sha256,created_at FROM program_files
      WHERE company_id=$1 AND machine_id=$2 AND kind='BACKUP' AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1`, [machine.company_id, machine.id]),
    pool.query(`SELECT DISTINCT ON (j.action) ${jobs.JOB_COLUMNS} FROM program_jobs j ${jobs.JOB_JOINS}
      WHERE j.company_id=$1 AND j.machine_id=$2 AND j.protocol_version=2 ORDER BY j.action,j.requested_at DESC,j.id DESC`, [machine.company_id, machine.id]),
    pool.query(`SELECT id AS device_id,last_seen_at,COALESCE(last_seen_at>NOW()-INTERVAL '60 seconds',false) AS online FROM program_devices
      WHERE company_id=$1 AND machine_id=$2 AND revoked_at IS NULL`, [machine.company_id, machine.id])
  ]);
  return { machine: { id: machine.id, ip_address: machine.ip_address, program_path: machine.program_path,
      device_id: null, last_seen_at: null, online: false, ...one(device) },
    file: one(current) || null, backup: one(backup) || null, jobs: latest.rows.map(jobs.view) };
};

function assertDeviceJob(job, device) {
  if (!job || job.company_id !== device.company_id || job.machine_id !== device.machine.id || job.protocol_version !== 2) throw fail('Command not found for this machine.', 'JOB_NOT_FOUND', 404);
  if (job.device_id !== device.id) throw fail('This command belongs to a different device token.', 'DEVICE_CHANGED', 409);
}
function assertInTime(job) {
  if (job.status !== 'DELIVERED') throw fail('This command is no longer active.', 'JOB_NOT_OPEN', 409);
  if (job.expires_at && new Date(job.expires_at).getTime() <= Date.now()) throw fail('The command deadline has passed. Check the controller before retrying.', 'DEVICE_TIMEOUT', 409);
}
async function lockJob(client, device, id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw fail('Provide the command number.', 'BAD_JOB');
  const locked = await client.query('SELECT id FROM program_jobs WHERE id=$1 AND machine_id=$2 AND company_id=$3 FOR UPDATE', [id, device.machine.id, device.company_id]);
  if (!locked.rows.length) throw fail('Command not found for this machine.', 'JOB_NOT_FOUND', 404);
  const job = await jobs.getJob(id, client);
  assertDeviceJob(job, device);
  return job;
}
exports.result = async (device, id, body) => {
  const status = String(body.status || '').toUpperCase();
  if (!['DONE', 'FAILED'].includes(status)) throw fail('Report DONE or FAILED.', 'BAD_STATUS');
  const message = String(body.message || '').trim().slice(0, 1000);
  if (status === 'FAILED' && !message) throw fail('Explain the device error.', 'NO_MESSAGE');
  const errorCode = status === 'FAILED' ? String(body.error_code || 'DEVICE_ERROR') : null;
  if (errorCode && !/^[A-Z][A-Z0-9_]{0,59}$/.test(errorCode)) throw fail('Use an uppercase device error code.', 'BAD_ERROR_CODE');
  const client = await pool.connect();
  let finished;
  try {
    await client.query('BEGIN');
    const job = await lockJob(client, device, id);
    if (status === 'DONE' && job.action === 'BACKUP') {
      if (!job.file_id || job.status !== 'DONE') throw fail('Upload the requested backup file to complete this command.', 'NO_FILE', 409);
    }
    if (status === 'DONE' && job.action === 'SEND' && (body.sha256 !== job.file_sha256 || body.verified !== true || typeof body.replaced !== 'boolean')) throw fail('Confirm controller read-back, the exact SHA-256 and whether a program was replaced before reporting success.', 'WRITE_NOT_VERIFIED', 409);
    if (status === 'DONE' && job.action === 'SEND' && body.replaced && (!job.overwrite || !job.backup_file_id)) throw fail('An authorized replacement must have its previous program saved on the server first.', 'BACKUP_REQUIRED', 409);
    if (!OPEN.includes(job.status)) {
      if (job.status !== status || (status === 'FAILED' && (job.error_code !== errorCode || (job.message || '') !== message))) throw fail('This command has a different recorded result.', 'RESULT_CONFLICT', 409);
      await client.query('COMMIT');
      return jobs.view(job);
    }
    assertInTime(job);
    await client.query(`UPDATE program_jobs SET status=$2,message=$3,error_code=$4,finished_at=NOW() WHERE id=$1`, [job.id, status, message || null, errorCode]);
    finished = await jobs.getJob(job.id, client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
  await announce(finished);
  return jobs.view(finished);
};
const backupView = row => ({ id: Number(row.id), kind: row.kind, program_name: row.program_name,
  stored_as: `${row.folder}/${row.stored_name}`, size: row.size_bytes, sha256: row.sha256, created_at: row.created_at });
async function storeCapture(device, body, upload, replacement = false) {
  if (!upload) throw fail('Upload the actual controller program as file.', 'NO_FILE');
  const name = String(body.program_name || '').trim();
  if (!name || storage.safeProgramName(name) !== name) throw fail('Send the actual running program filename without a path.', 'BAD_NAME');
  storage.checkContent(upload.buffer);
  const checksum = storage.sha256(upload.buffer);
  if (body.sha256 !== checksum) throw fail('The uploaded backup checksum does not match.', 'CHECKSUM_MISMATCH', 422);
  const client = await pool.connect();
  let saved, row, finished, committing = false;
  try {
    await client.query('BEGIN');
    const job = await lockJob(client, device, body.job_id);
    if (job.action !== (replacement ? 'SEND' : 'BACKUP')) throw fail('This backup does not match the requested command action.', 'WRONG_ACTION', 409);
    if (replacement && name !== job.program_name) throw fail('The replacement backup must name the program being replaced.', 'BAD_NAME');
    const previousFile = replacement ? job.backup_file_id : job.file_id;
    if (previousFile && (job.status === 'DONE' || job.status === 'DELIVERED')) {
      if (job.status === 'DELIVERED') assertInTime(job);
      row = await savedFile(client, previousFile, device.company_id);
      if (!row || row.sha256 !== checksum || row.program_name !== name) throw fail('This command already saved a different backup.', 'RESULT_CONFLICT', 409);
      await client.query('COMMIT');
      return backupView(row);
    }
    assertInTime(job);
    saved = await storage.save({ machine: { ...device.machine, ip_address: job.controller_ip }, kind: 'BACKUP', programName: name, buffer: upload.buffer });
    row = one(await client.query(`INSERT INTO program_files(company_id,machine_id,folder,stored_name,program_name,kind,size_bytes,sha256,device_id,job_id,note)
      VALUES($1,$2,$3,$4,$5,'BACKUP',$6,$7,$8,$9,$10) RETURNING id,folder,stored_name,program_name,kind,size_bytes,sha256,created_at`,
    [device.company_id, device.machine.id, saved.folder, saved.storedName, name, saved.size, saved.sha256, device.id, job.id, body.note ? String(body.note).slice(0, 255) : null]));
    if (replacement) await client.query('UPDATE program_jobs SET backup_file_id=$2 WHERE id=$1', [job.id, row.id]);
    else await client.query(`UPDATE program_jobs SET file_id=$2,program_name=$3,status='DONE',error_code=NULL,message=NULL,finished_at=NOW() WHERE id=$1`, [job.id, row.id, name]);
    finished = await jobs.getJob(job.id, client);
    committing = true;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (saved && !committing) await storage.remove(saved.folder, saved.storedName).catch(() => {});
    throw error;
  } finally { client.release(); }
  if (!replacement) await announce(finished);
  return backupView(row);
}
exports.storeBackup = (device, body, upload) => storeCapture(device, body, upload);
exports.storeReplacementBackup = (device, body, upload) => storeCapture(device, body, upload, true);
