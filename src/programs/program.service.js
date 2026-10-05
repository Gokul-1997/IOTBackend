/**
 * Program Transfer, the people's side (/api/programs).
 *
 * The server no longer reaches into the factory. A person uploads a program
 * into the machine's folder and asks for it to be sent, or asks for a
 * program on the controller; each becomes a job, and the machine's device
 * collects it the next time it asks for work (device.service). The device
 * writes the program to the controller — saving what it replaces as a
 * BACKUP first — or uploads what was asked for, and reports back.
 */
const pool = require('../db');
const storage = require('./storage');
const jobs = require('./jobs');
const deviceToken = require('./device-token');
const audit = require('../audit/audit.service');

const MAX_JOBS_PER_REQUEST = 50;

const fail = (message, code, status = 400, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });

const allowed = (req, key) => !!req.user?.is_snt_super || (req.user?.permissions || []).includes(key);

function pageOf(query, defLimit = 20) {
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || defLimit));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
}

/** A machine of the caller's company that is switched on, or a 404. */
async function getMachine(machineId, companyId) {
  const id = Number(machineId);
  if (!Number.isInteger(id) || id <= 0) throw fail('Choose a machine.', 'NO_MACHINE');
  const { rows } = await pool.query(
    `SELECT id, company_id, machine_serial_no, ip_address
       FROM machines WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [id, companyId]
  );
  if (!rows.length) throw fail('Machine not found.', 'MACHINE_NOT_FOUND', 404);
  return rows[0];
}

async function getFile(fileId, companyId) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id <= 0) throw fail('File not found.', 'FILE_NOT_FOUND', 404);
  const { rows } = await pool.query(
    `SELECT id, company_id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256
       FROM program_files WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [id, companyId]
  );
  if (!rows.length) throw fail('File not found.', 'FILE_NOT_FOUND', 404);
  return rows[0];
}

/* "O1234.nc" and "O1234" are the same program to a Fanuc: compare without case or extension */
const sameProgram = (a, b) => {
  const k = s => String(s || '').toLowerCase().replace(/\.[^.]+$/, '');
  return k(a) === k(b);
};

/**
 * Before a SEND is queued: refuse a second job for the same program while
 * one is still open, and — unless the person confirmed an overwrite — refuse
 * a program the device last reported as already on the controller. The
 * device checks again when it writes (the list may be minutes old).
 */
async function checkSend(machine, programName, overwrite) {
  const open = await pool.query(
    `SELECT program_name FROM program_jobs
      WHERE machine_id = $1 AND action = 'SEND' AND status = ANY($2)`,
    [machine.id, jobs.OPEN]
  );
  if (open.rows.some(r => sameProgram(r.program_name, programName))) {
    return { duplicate: true };
  }
  if (overwrite) return {};
  const listed = await pool.query(`SELECT files FROM program_controller_files WHERE machine_id = $1`, [machine.id]);
  const onController = (listed.rows[0]?.files || []).some(f => sameProgram(f.name, programName));
  return onController ? { exists: true } : {};
}

async function insertJob({ companyId, machine, action, programName, fileId = null, overwrite = false, userId }) {
  const { rows } = await pool.query(
    `INSERT INTO program_jobs (company_id, machine_id, machine_serial, action, program_name, file_id, overwrite, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [companyId, machine.id, machine.machine_serial_no, action, programName, fileId, !!overwrite, userId]
  );
  const job = await jobs.getJob(rows[0].id);
  await jobs.announce(job);
  return jobs.view(job);
}

async function insertFile({ machine, saved, userId, note }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO program_files (company_id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256, uploaded_by, note)
       VALUES ($1, $2, $3, $4, $5, 'NEW', $6, $7, $8, $9)
       RETURNING id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256, note, created_at`,
      [machine.company_id, machine.id, saved.folder, saved.storedName, saved.programName,
       saved.size, saved.sha256, userId, note ? String(note).slice(0, 255) : null]
    );
    return rows[0];
  } catch (err) {
    await storage.remove(saved.folder, saved.storedName).catch(() => {});   // no file without its row
    throw err;
  }
}

/* ─────────────── machines and their devices ─────────────── */

exports.listMachines = async (req) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.company_id, m.machine_serial_no, m.ip_address,
            d.id AS device_id, d.token_prefix, d.label AS device_label, d.created_at AS device_created_at,
            d.last_seen_at, d.last_seen_ip, d.agent_version,
            COALESCE(d.last_seen_at > NOW() - make_interval(secs => $2), false) AS online,
            (SELECT COUNT(*)::int FROM program_jobs j
              WHERE j.machine_id = m.id AND j.status IN ('QUEUED', 'DELIVERED')) AS open_jobs,
            c.reported_at AS controller_reported_at
       FROM machines m
       LEFT JOIN program_devices d ON d.machine_id = m.id AND d.revoked_at IS NULL
       LEFT JOIN program_controller_files c ON c.machine_id = m.id
      WHERE m.company_id = $1 AND m.is_active = true
      ORDER BY m.machine_serial_no`,
    [req.user.company_id, jobs.ONLINE_WINDOW_SEC]
  );
  return rows.map(({ company_id, ...m }) => ({ ...m, folder: storage.machineFolder({ ...m, company_id }) }));
};

exports.controllerFiles = async (req) => {
  const machine = await getMachine(req.params.machineId, req.user.company_id);
  const { rows } = await pool.query(
    `SELECT files, reported_at FROM program_controller_files WHERE machine_id = $1`, [machine.id]
  );
  return { files: rows[0]?.files || [], reported_at: rows[0]?.reported_at || null };
};

/* ─────────────── files in the ProgramTransfer folder ─────────────── */

exports.listFiles = async (req) => {
  const { machine_id, kind, search } = req.query;
  const { limit, page, offset } = pageOf(req.query, 50);
  const values = [req.user.company_id];
  let where = `f.company_id = $1 AND f.deleted_at IS NULL`;
  if (machine_id) { values.push(Number(machine_id)); where += ` AND f.machine_id = $${values.length}`; }
  if (kind) { values.push(String(kind).toUpperCase()); where += ` AND f.kind = $${values.length}`; }
  if (search) {
    values.push(`%${String(search).replace(/[%_\\]/g, '\\$&')}%`);
    where += ` AND (f.program_name ILIKE $${values.length} OR f.stored_name ILIKE $${values.length})`;
  }
  const [data, count] = await Promise.all([
    pool.query(
      `SELECT f.id, f.machine_id, m.machine_serial_no, f.folder, f.stored_name, f.program_name, f.kind,
              f.size_bytes, f.sha256, f.note, f.job_id, f.created_at, u.username AS uploaded_by_name
         FROM program_files f
         LEFT JOIN machines m ON m.id = f.machine_id
         LEFT JOIN users u    ON u.id = f.uploaded_by
        WHERE ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM program_files f WHERE ${where}`, values)
  ]);
  return { data: data.rows, total: count.rows[0].total, page, limit };
};

/**
 * A new program into the machine's folder — and, with send, straight into a
 * job for its device. The checks run before anything is written, so a
 * refused send ("already on the machine — overwrite?") leaves no file behind
 * to be saved a second time when the person confirms.
 */
exports.uploadFile = async (req) => {
  if (!req.file) throw fail('Choose a program file.', 'NO_FILE');
  const body = req.body || {};
  const send = String(body.send) === 'true';
  const overwrite = String(body.overwrite) === 'true';
  if (send && !allowed(req, 'page:programs:transfer')) {
    throw fail('Sending a program to a machine is not part of your role.', 'FORBIDDEN', 403);
  }

  const machine = await getMachine(body.machine_id, req.user.company_id);
  const programName = storage.safeProgramName(body.program_name || req.file.originalname);
  storage.checkContent(req.file.buffer);

  if (send) {
    const check = await checkSend(machine, programName, overwrite);
    if (check.duplicate) throw fail(`${programName} is already waiting to go to ${machine.machine_serial_no}.`, 'DUPLICATE_JOB', 409);
    if (check.exists) {
      throw fail(`${programName} is already on ${machine.machine_serial_no}.`, 'FILE_EXISTS', 409, { names: [programName] });
    }
  }

  const saved = await storage.save({ machine, kind: 'NEW', programName, buffer: req.file.buffer });
  const file = await insertFile({ machine, saved, userId: req.user.id, note: body.note });
  const job = send
    ? await insertJob({ companyId: machine.company_id, machine, action: 'SEND', programName: file.program_name,
                        fileId: file.id, overwrite, userId: req.user.id })
    : null;

  audit.log({ user_id: req.user.id, company_id: machine.company_id, action: 'PROGRAM_UPLOAD', resource: 'program_file',
              resource_id: file.id, new_value: { machine: machine.machine_serial_no, file: `${file.folder}/${file.stored_name}`, send },
              ip_address: req.ip, user_agent: req.headers['user-agent'] });
  return { file, job };
};

exports.getFileForDownload = async (req) => getFile(req.params.id, req.user.company_id);

/** Delete a file from the folder. Its row stays (deleted_at), so the history still names it. */
exports.deleteFile = async (req) => {
  const file = await getFile(req.params.id, req.user.company_id);
  const open = await pool.query(
    `SELECT id FROM program_jobs WHERE file_id = $1 AND status = ANY($2) LIMIT 1`, [file.id, jobs.OPEN]
  );
  if (open.rowCount) throw fail('This program is waiting to be sent. Cancel that first.', 'IN_USE', 409);

  await storage.remove(file.folder, file.stored_name);
  await pool.query(`UPDATE program_files SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [file.id, req.user.id]);
  audit.log({ user_id: req.user.id, company_id: file.company_id, action: 'PROGRAM_DELETE', resource: 'program_file',
              resource_id: file.id, old_value: { file: `${file.folder}/${file.stored_name}` },
              ip_address: req.ip, user_agent: req.headers['user-agent'] });
};

/* ─────────────── jobs ─────────────── */

/**
 * SEND: files × machines. A file sent to a machine other than its own is
 * copied into that machine's folder first, so each folder holds every
 * program that went to that machine.
 * FETCH: program names to read off one machine's controller.
 * Every pair is checked before any job is created: one refusal queues none.
 */
exports.createJobs = async (req) => {
  const body = req.body || {};
  const action = String(body.action || '').toUpperCase();
  const companyId = req.user.company_id;

  if (action === 'FETCH') {
    if (!allowed(req, 'page:programs:fetch')) throw fail('Fetching from a machine is not part of your role.', 'FORBIDDEN', 403);
    const machine = await getMachine(body.machine_id, companyId);
    const names = [...new Set((body.program_names || []).map(n => storage.safeProgramName(n)))];
    if (!names.length) throw fail('Choose a program on the machine.', 'NO_PROGRAM');
    if (names.length > MAX_JOBS_PER_REQUEST) throw fail(`At most ${MAX_JOBS_PER_REQUEST} programs at a time.`, 'TOO_MANY');
    const open = await pool.query(
      `SELECT program_name FROM program_jobs WHERE machine_id = $1 AND action = 'FETCH' AND status = ANY($2)`,
      [machine.id, jobs.OPEN]
    );
    const waiting = names.filter(n => open.rows.some(r => sameProgram(r.program_name, n)));
    if (waiting.length) throw fail(`Already asked for: ${waiting.join(', ')}.`, 'DUPLICATE_JOB', 409, { names: waiting });
    const created = [];
    for (const name of names) {
      created.push(await insertJob({ companyId, machine, action: 'FETCH', programName: name, userId: req.user.id }));
    }
    return { jobs: created };
  }

  if (action !== 'SEND') throw fail('action must be SEND or FETCH.', 'BAD_ACTION');
  if (!allowed(req, 'page:programs:transfer')) throw fail('Sending a program to a machine is not part of your role.', 'FORBIDDEN', 403);

  const fileIds = [...new Set((body.file_ids || []).map(Number))];
  const machineIds = [...new Set((body.machine_ids || []).map(Number))];
  if (!fileIds.length) throw fail('Choose a program to send.', 'NO_PROGRAM');
  if (!machineIds.length) throw fail('Choose a machine.', 'NO_MACHINE');
  if (fileIds.length * machineIds.length > MAX_JOBS_PER_REQUEST) {
    throw fail(`At most ${MAX_JOBS_PER_REQUEST} transfers at a time.`, 'TOO_MANY');
  }
  const overwrite = body.overwrite === true || String(body.overwrite) === 'true';

  const files = [];
  for (const id of fileIds) files.push(await getFile(id, companyId));
  const machines = [];
  for (const id of machineIds) machines.push(await getMachine(id, companyId));

  const exists = [];
  const duplicates = [];
  for (const machine of machines) {
    for (const file of files) {
      const check = await checkSend(machine, file.program_name, overwrite);
      if (check.duplicate) duplicates.push(`${file.program_name} → ${machine.machine_serial_no}`);
      if (check.exists) exists.push(`${file.program_name} on ${machine.machine_serial_no}`);
    }
  }
  if (duplicates.length) {
    throw fail(`Already waiting to be sent: ${duplicates.join(', ')}.`, 'DUPLICATE_JOB', 409, { names: duplicates });
  }
  if (exists.length) throw fail(`Already on the machine: ${exists.join(', ')}.`, 'FILE_EXISTS', 409, { names: exists });

  const created = [];
  for (const machine of machines) {
    for (const file of files) {
      let fileId = file.id;
      if (file.machine_id !== machine.id) {
        const saved = await storage.save({
          machine, kind: 'NEW', programName: file.program_name,
          buffer: await storage.read(file.folder, file.stored_name)
        });
        fileId = (await insertFile({ machine, saved, userId: req.user.id, note: `Copied from ${file.folder}/${file.stored_name}` })).id;
      }
      created.push(await insertJob({ companyId, machine, action: 'SEND', programName: file.program_name,
                                     fileId, overwrite, userId: req.user.id }));
    }
  }
  audit.log({ user_id: req.user.id, company_id: companyId, action: 'PROGRAM_SEND', resource: 'program_job',
              new_value: { jobs: created.map(j => j.id), overwrite }, ip_address: req.ip, user_agent: req.headers['user-agent'] });
  return { jobs: created };
};

exports.listJobs = async (req) => {
  const { machine_id, status, action } = req.query;
  const { limit, page, offset } = pageOf(req.query, 20);
  const values = [req.user.company_id];
  let where = `j.company_id = $1`;
  if (machine_id) { values.push(Number(machine_id)); where += ` AND j.machine_id = $${values.length}`; }
  if (action) { values.push(String(action).toUpperCase()); where += ` AND j.action = $${values.length}`; }
  if (status === 'open') { values.push(jobs.OPEN); where += ` AND j.status = ANY($${values.length})`; }
  else if (status) { values.push(String(status).toUpperCase()); where += ` AND j.status = $${values.length}`; }

  const [data, count] = await Promise.all([
    pool.query(
      `SELECT ${jobs.JOB_COLUMNS} FROM program_jobs j ${jobs.JOB_JOINS}
        WHERE ${where}
        ORDER BY j.requested_at DESC, j.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM program_jobs j WHERE ${where}`, values)
  ]);
  return { data: data.rows.map(jobs.view), total: count.rows[0].total, page, limit };
};

/** Withdraw a job the device has not taken yet. */
exports.cancelJob = async (req) => {
  const job = await jobs.getJob(Number(req.params.id) || 0);
  if (!job || job.company_id !== req.user.company_id) throw fail('Job not found.', 'JOB_NOT_FOUND', 404);
  const need = job.action === 'SEND' ? 'page:programs:transfer' : 'page:programs:fetch';
  if (!allowed(req, need)) throw fail('Cancelling this job is not part of your role.', 'FORBIDDEN', 403);
  if (job.status !== 'QUEUED') {
    throw fail(job.status === 'DELIVERED'
      ? 'The machine\'s device has already taken this job; it can no longer be cancelled.'
      : `This job is already ${job.status.toLowerCase()}.`, 'JOB_NOT_OPEN', 409);
  }
  const { rowCount } = await pool.query(
    `UPDATE program_jobs SET status = 'CANCELLED', finished_at = NOW(), message = $2
      WHERE id = $1 AND status = 'QUEUED'`,
    [job.id, `Cancelled by ${req.user.username || 'a user'}.`]
  );
  if (!rowCount) throw fail('The machine\'s device took this job a moment ago; it can no longer be cancelled.', 'JOB_NOT_OPEN', 409);
  const done = await jobs.getJob(job.id);
  await jobs.announce(done);
  return jobs.view(done);
};

/* ─────────────── device tokens ─────────────── */

/**
 * A new token for the machine's device. Any token it had stops working now:
 * one machine, one live token. The token is in this answer only — it is not
 * stored, and cannot be shown again.
 */
exports.createDeviceToken = async (req) => {
  const machine = await getMachine(req.params.machineId, req.user.company_id);
  const label = req.body?.label ? String(req.body.label).trim().slice(0, 100) : null;
  const { token, hash, prefix } = deviceToken.generate();

  const client = await pool.connect();
  let device;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE program_devices SET revoked_at = NOW(), revoked_by = $2 WHERE machine_id = $1 AND revoked_at IS NULL`,
      [machine.id, req.user.id]
    );
    ({ rows: [device] } = await client.query(
      `INSERT INTO program_devices (company_id, machine_id, label, token_prefix, token_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, machine_id, label, token_prefix, created_at`,
      [machine.company_id, machine.id, label, prefix, hash, req.user.id]
    ));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  audit.log({ user_id: req.user.id, company_id: machine.company_id, action: 'DEVICE_TOKEN_CREATE', resource: 'program_device',
              resource_id: device.id, new_value: { machine: machine.machine_serial_no, token_prefix: prefix },
              ip_address: req.ip, user_agent: req.headers['user-agent'] });
  return { token, device: { ...device, machine_serial_no: machine.machine_serial_no, folder: storage.machineFolder(machine) } };
};

/** Stop the machine's device at once (a lost or replaced device). */
exports.revokeDeviceToken = async (req) => {
  const machine = await getMachine(req.params.machineId, req.user.company_id);
  const { rows } = await pool.query(
    `UPDATE program_devices SET revoked_at = NOW(), revoked_by = $2
      WHERE machine_id = $1 AND revoked_at IS NULL RETURNING id, token_prefix`,
    [machine.id, req.user.id]
  );
  if (!rows.length) throw fail('This machine has no device token.', 'NO_DEVICE', 404);
  audit.log({ user_id: req.user.id, company_id: machine.company_id, action: 'DEVICE_TOKEN_REVOKE', resource: 'program_device',
              resource_id: rows[0].id, old_value: { machine: machine.machine_serial_no, token_prefix: rows[0].token_prefix },
              ip_address: req.ip, user_agent: req.headers['user-agent'] });
};

exports._internal = { sameProgram, checkSend };
