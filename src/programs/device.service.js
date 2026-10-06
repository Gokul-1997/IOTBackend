/**
 * The device side of Program Transfer: what the machine's device calls.
 * Every function receives req.device from device.middleware — the device,
 * its company and its one machine — and touches nothing outside that
 * machine: a device can never see or change another machine's programs.
 */
const pool = require('../db');
const storage = require('./storage');
const jobs = require('./jobs');
const { targetFile } = require('./program-path');

/** How often a device should ask for work, said back on /ping so it can be tuned centrally. */
const POLL_SECONDS = Number(process.env.DEVICE_POLL_SECONDS) || 15;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/** The job, if it is this machine's and in one of the given states. */
async function ownJob(device, jobId, { action, status = ['DELIVERED'] } = {}) {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) throw fail('job_id must be a job number.', 'BAD_JOB');
  const job = await jobs.getJob(id);
  if (!job || job.machine_id !== device.machine.id || job.company_id !== device.company_id) {
    throw fail(`Job ${id} is not a job for this machine.`, 'JOB_NOT_FOUND', 404);
  }
  if (action && job.action !== action) throw fail(`Job ${id} is a ${job.action} job, not ${action}.`, 'WRONG_ACTION', 409);
  if (!status.includes(job.status)) {
    throw fail(`Job ${id} is ${job.status}; it has to be ${status.join(' or ')} for this.`, 'JOB_NOT_OPEN', 409);
  }
  return job;
}

/**
 * What a device sees about a job. program_path is where on the machine the
 * program goes (SEND) or is read from (FETCH) — the machine's path when the
 * job was made — and target_file the program's full name there.
 */
function forDevice(job, device) {
  const path = job.program_path || device.machine.program_path || null;
  return {
    id: Number(job.id),
    action: job.action,
    program_name: job.program_name,
    program_path: path,
    target_file: targetFile(path, job.program_name),
    overwrite: job.overwrite,
    requested_at: job.requested_at,
    requested_by: job.requested_by_name || null,
    file: job.action === 'SEND'
      ? { size: job.file_size, sha256: job.file_sha256, url: `/api/device/v1/jobs/${job.id}/file` }
      : null
  };
}

exports.ping = async (device) => ({
  device_id: device.id,
  machine: { serial: device.machine.machine_serial_no, ip_address: storage.machineIp(device.machine),
             // where this machine's programs live: list it, back it up, save new programs there
             program_path: device.machine.program_path || null },
  server_time: new Date().toISOString(),
  poll_seconds: POLL_SECONDS
});

/**
 * The oldest queued job for this machine, now marked DELIVERED to this
 * device — or null. SKIP LOCKED: two calls at once (a device restarted
 * mid-poll) can never both take the same job.
 */
exports.nextJob = async (device) => {
  const { rows } = await pool.query(
    `UPDATE program_jobs
        SET status = 'DELIVERED', delivered_at = NOW(), device_id = $2
      WHERE id = (SELECT id FROM program_jobs
                   WHERE machine_id = $1 AND company_id = $3 AND status = 'QUEUED'
                   ORDER BY requested_at, id
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [device.machine.id, device.id, device.company_id]
  );
  if (!rows.length) return null;
  const job = await jobs.getJob(rows[0].id);
  await jobs.announce(job);
  return forDevice(job, device);
};

/** The file of a SEND job the device has taken. */
exports.jobFile = async (device, jobId) => {
  const job = await ownJob(device, jobId, { action: 'SEND' });
  const { rows } = await pool.query(
    `SELECT folder, stored_name, size_bytes, sha256 FROM program_files WHERE id = $1 AND deleted_at IS NULL`,
    [job.file_id]
  );
  if (!rows.length) throw fail('The program for this job was deleted from the server.', 'FILE_GONE', 410);
  return { job, file: rows[0] };
};

/**
 * A program read off the controller. type tells what it is:
 *   BACKUP   what was on the controller — before an overwrite (job_id = the
 *            SEND job) or on the device's own schedule (no job_id)
 *   FETCHED  what a user asked for (job_id = the FETCH job, which this
 *            completes)
 */
exports.uploadFile = async (device, { file, type, job_id, program_name, sha256, note }) => {
  const kind = String(type || '').toUpperCase();
  if (!['BACKUP', 'FETCHED'].includes(kind)) throw fail('type must be BACKUP or FETCHED.', 'BAD_TYPE');
  if (!file) throw fail('Send the program as the multipart field "file".', 'NO_FILE');

  let job = null;
  if (kind === 'FETCHED') {
    if (!job_id) throw fail('A FETCHED file answers a FETCH job: send its job_id.', 'BAD_JOB');
    job = await ownJob(device, job_id, { action: 'FETCH' });
  } else if (job_id) {
    job = await ownJob(device, job_id, { action: 'SEND' });
  }

  const name = program_name || (kind === 'FETCHED' ? job.program_name : file.originalname);
  if (sha256 && String(sha256).toLowerCase() !== storage.sha256(file.buffer)) {
    throw fail('The file arrived changed: its SHA-256 does not match the one sent. Send it again.', 'CHECKSUM_MISMATCH', 422);
  }

  const saved = await storage.save({ machine: device.machine, kind, programName: name, buffer: file.buffer });
  let row;
  try {
    ({ rows: [row] } = await pool.query(
      `INSERT INTO program_files
         (company_id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256, device_id, job_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, folder, stored_name, program_name, kind, size_bytes, sha256, created_at`,
      [device.company_id, device.machine.id, saved.folder, saved.storedName, saved.programName, kind,
       saved.size, saved.sha256, device.id, job ? job.id : null, note ? String(note).slice(0, 255) : null]
    ));
  } catch (err) {
    await storage.remove(saved.folder, saved.storedName).catch(() => {});   // no file without its row
    throw err;
  }

  if (job && kind === 'BACKUP') {
    await pool.query(`UPDATE program_jobs SET backup_file_id = $2 WHERE id = $1`, [job.id, row.id]);
  }
  if (job && kind === 'FETCHED') {
    await pool.query(`UPDATE program_jobs SET file_id = $2 WHERE id = $1`, [job.id, row.id]);
    await jobs.finish(job.id, 'DONE', null);
  }
  return { id: Number(row.id), kind: row.kind, program_name: row.program_name, stored_as: `${row.folder}/${row.stored_name}`,
           size: row.size_bytes, sha256: row.sha256, created_at: row.created_at };
};

/** The device's report on a job: DONE, or FAILED with what went wrong. */
exports.reportResult = async (device, jobId, { status, message }) => {
  const s = String(status || '').toUpperCase();
  if (!['DONE', 'FAILED'].includes(s)) throw fail('status must be DONE or FAILED.', 'BAD_STATUS');
  if (s === 'FAILED' && !String(message || '').trim()) throw fail('Say what went wrong in "message".', 'NO_MESSAGE');

  const job = await ownJob(device, jobId, { status: ['DELIVERED', 'DONE', 'FAILED'] });
  if (job.status !== 'DELIVERED') {
    // the same report twice (a retry after a timeout) is fine; a different one is not
    if (job.status === s) return jobs.view(job);
    throw fail(`Job ${job.id} was already reported ${job.status}.`, 'JOB_NOT_OPEN', 409);
  }
  if (s === 'DONE' && job.action === 'FETCH' && !job.file_id) {
    throw fail('A FETCH job is done when its file is uploaded with type FETCHED.', 'NO_FILE', 409);
  }
  return jobs.view(await jobs.finish(job.id, s, message));
};

/** What is on the controller right now, for the screen's "On the machine" list. */
exports.reportControllerFiles = async (device, files) => {
  if (!Array.isArray(files)) throw fail('Send {"files": [ … ]}.', 'BAD_LIST');
  if (files.length > 5000) throw fail('At most 5000 files in one report.', 'BAD_LIST');
  const clean = files.map((f, i) => {
    const name = String(f?.name ?? '').trim();
    if (!name || name.length > 255) throw fail(`files[${i}].name is missing or too long.`, 'BAD_LIST');
    const size = f.size == null ? null : Number(f.size);
    const modified = f.modified ? new Date(f.modified) : null;
    return {
      name,
      size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
      modified: modified && !Number.isNaN(modified.getTime()) ? modified.toISOString() : null,
      comment: f.comment ? String(f.comment).slice(0, 120) : null
    };
  });
  await pool.query(
    `INSERT INTO program_controller_files (machine_id, company_id, files, reported_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (machine_id) DO UPDATE SET files = EXCLUDED.files, company_id = EXCLUDED.company_id, reported_at = NOW()`,
    [device.machine.id, device.company_id, JSON.stringify(clean)]
  );
  return { count: clean.length };
};

exports.POLL_SECONDS = POLL_SECONDS;
