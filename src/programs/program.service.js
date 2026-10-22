/**
 * Program Transfer — kept simple (21 Oct 2026, the user: "just API, don't
 * complicate").
 *
 *   People (/api/programs, signed in):
 *     pick a machine of their company, upload a program, download any file,
 *     delete one, ask the machine for a backup.
 *   The machine's gateway (/api/device/v1, its own token):
 *     GET  /status   is there a new program? was a backup asked for?
 *     GET  /program  the machine's program
 *     POST /backup   a backup file from the machine
 *     POST /report   what happened: the program is on the machine, the
 *                    machine refused it, or a backup could not be read
 *
 * That is all. How the gateway talks to the CNC (FTP, FOCAS, a USB stick…) is
 * the gateway team's business, not the server's: there is no protocol, no
 * command queue and no controller path here. One token per machine
 * ("mxd_…") says which machine a call is about.
 *
 * Files are rows in program_files (migration 030). The machine's program is
 * its newest upload (kind NEW); a backup (kind BACKUP) never replaces it.
 * Backup requests are program_backup_requests (050), one open per machine.
 * The gateway's reports are columns on those two tables (051).
 */
const pool = require('../db');
const storage = require('./storage');
const deviceToken = require('./device-token');
const audit = require('../audit/audit.service');
const { announceUnread } = require('../notifications/notification.service');
const { programLink } = require('../notifications/links');
const { plantSql } = require('../lib/read-scope');
const { effectivePlantId } = require('../lib/plant-scope');

/** A device is "online" when it called within this long. */
const ONLINE_WINDOW_SEC = 60;
/** A backup request the gateway has not answered by then can be asked again. */
const BACKUP_WAIT_MIN = 30;
/** How often a gateway is asked to call /status. */
const POLL_SECONDS = 15;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

function pageOf(query, defLimit = 20) {
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defLimit));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
}

function idOf(value, message, code) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(message, code, 404);
  return id;
}

const scope = (req) => ({ companyId: req.user.company_id, plantId: effectivePlantId(req.user) });

/** A switched-on machine of the caller's company (and plant, for a plant user), or a 404. */
async function getMachine(req, machineId) {
  const id = idOf(machineId, 'Machine not found.', 'MACHINE_NOT_FOUND');
  const { companyId, plantId } = scope(req);
  const { rows } = await pool.query(
    `SELECT id, company_id, machine_serial_no
       FROM machines WHERE id = $1 AND company_id = $2 AND is_active = true${plantSql('id', plantId, companyId)}`,
    [id, companyId]
  );
  if (!rows.length) throw fail('Machine not found.', 'MACHINE_NOT_FOUND', 404);
  return rows[0];
}

const FILE_COLUMNS = `f.id, f.machine_id, f.program_name, f.kind, f.size_bytes, f.sha256, f.created_at,
  f.delivery_status, f.delivery_message, f.delivered_at`;

/** The machine's program: its newest upload that has not been deleted. */
async function currentProgram(machineId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${FILE_COLUMNS}, f.folder, f.stored_name
       FROM program_files f
      WHERE f.machine_id = $1 AND f.kind = 'NEW' AND f.deleted_at IS NULL
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT 1`,
    [machineId]
  );
  return rows[0] || null;
}

async function saveFile({ machine, kind, staged, programName, userId = null, deviceId = null }) {
  if (!staged) throw fail('Attach the program file as "file".', 'NO_FILE');
  const saved = await storage.saveStream({
    machine, kind, programName: programName || staged.originalname, filename: staged.path
  });
  try {
    const { rows } = await pool.query(
      `INSERT INTO program_files (company_id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256, uploaded_by, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, machine_id, program_name, kind, size_bytes, sha256, created_at`,
      [machine.company_id, machine.id, saved.folder, saved.storedName, saved.programName, kind,
       saved.size, saved.sha256, userId, deviceId]
    );
    return rows[0];
  } catch (err) {
    await storage.remove(saved.folder, saved.storedName).catch(() => {});   // no file without its row
    throw err;
  }
}

const auditOf = (req, entry) => audit.log({ user_id: req.user.id, company_id: req.user.company_id,
                                            ip_address: req.ip, user_agent: req.headers?.['user-agent'], ...entry });

/* ───────────────────────── people ───────────────────────── */

/** The company's machines, each with its gateway, its program, its last backup and an open backup request. */
exports.listMachines = async (req) => {
  const { companyId, plantId } = scope(req);
  const { rows } = await pool.query(
    `SELECT m.id, m.machine_serial_no,
            d.token_prefix, d.created_at AS token_created_at, d.last_seen_at,
            COALESCE(d.last_seen_at > NOW() - make_interval(secs => $2), false) AS online,
            p.id AS program_id, p.program_name, p.size_bytes AS program_size, p.created_at AS program_at,
            p.delivery_status, p.delivery_message, p.delivered_at,
            b.id AS backup_id, b.program_name AS backup_name, b.created_at AS backup_at,
            r.id AS request_id, r.requested_at,
            bf.error_message AS backup_error, bf.closed_at AS backup_failed_at
       FROM machines m
       LEFT JOIN program_devices d ON d.machine_id = m.id AND d.revoked_at IS NULL
       LEFT JOIN LATERAL (
              SELECT id, program_name, size_bytes, created_at, delivery_status, delivery_message, delivered_at FROM program_files
               WHERE machine_id = m.id AND kind = 'NEW' AND deleted_at IS NULL
               ORDER BY created_at DESC, id DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (
              SELECT id, program_name, created_at FROM program_files
               WHERE machine_id = m.id AND kind IN ('BACKUP', 'FETCHED') AND deleted_at IS NULL
               ORDER BY created_at DESC, id DESC LIMIT 1) b ON true
       LEFT JOIN program_backup_requests r
              ON r.machine_id = m.id AND r.closed_at IS NULL AND r.requested_at > NOW() - make_interval(mins => $3)
       LEFT JOIN LATERAL (
              SELECT error_message, closed_at FROM program_backup_requests
               WHERE machine_id = m.id AND error_message IS NOT NULL
               ORDER BY closed_at DESC LIMIT 1) bf ON true
      WHERE m.company_id = $1 AND m.is_active = true${plantSql('m.id', plantId, companyId)}
      ORDER BY m.machine_serial_no`,
    [companyId, ONLINE_WINDOW_SEC, BACKUP_WAIT_MIN]
  );
  return rows.map(r => ({
    id: r.id,
    machine_serial_no: r.machine_serial_no,
    gateway: r.token_prefix
      ? { token_prefix: r.token_prefix, token_created_at: r.token_created_at, last_seen_at: r.last_seen_at, online: r.online }
      : null,
    program: r.program_id ? { id: r.program_id, program_name: r.program_name, size_bytes: r.program_size, created_at: r.program_at,
                              delivery_status: r.delivery_status || null, delivery_message: r.delivery_message || null,
                              delivered_at: r.delivered_at || null } : null,
    last_backup: r.backup_id ? { id: r.backup_id, program_name: r.backup_name, created_at: r.backup_at } : null,
    backup_request: r.request_id ? { id: r.request_id, requested_at: r.requested_at } : null,
    // the last backup the gateway could not read — only while no backup has arrived since
    backup_failure: r.backup_error && !r.request_id && !(r.backup_at && new Date(r.backup_at) > new Date(r.backup_failed_at))
      ? { message: r.backup_error, at: r.backup_failed_at } : null
  }));
};

/** One machine's files, newest first. kind: uploads | backups (default: both). */
exports.listFiles = async (req) => {
  const machine = await getMachine(req, req.query.machine_id);
  const { limit, page, offset } = pageOf(req.query, 20);
  const kinds = { uploads: ['NEW'], backups: ['BACKUP', 'FETCHED'] }[String(req.query.kind || '')] || ['NEW', 'BACKUP', 'FETCHED'];
  const where = `f.machine_id = $1 AND f.company_id = $2 AND f.deleted_at IS NULL AND f.kind = ANY($3)`;
  const values = [machine.id, machine.company_id, kinds];
  const [data, count, current] = await Promise.all([
    pool.query(
      `SELECT ${FILE_COLUMNS}, u.username AS uploaded_by_name
         FROM program_files f LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $4 OFFSET $5`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM program_files f WHERE ${where}`, values),
    currentProgram(machine.id)
  ]);
  const total = count.rows[0].total;
  return {
    data: data.rows.map(f => ({ ...f, is_current: f.id === current?.id })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
};

/** Upload a program: it becomes the machine's program, for its gateway to download. */
exports.upload = async (req) => {
  const machine = await getMachine(req, req.body?.machine_id);
  const file = await saveFile({ machine, kind: 'NEW', staged: req.file, programName: req.body?.program_name, userId: req.user.id });
  auditOf(req, { action: 'PROGRAM_UPLOAD', resource: 'program_file', resource_id: file.id,
                 new_value: { machine: machine.machine_serial_no, program: file.program_name, sha256: file.sha256 } });
  return { ...file, is_current: true };
};

/** A file of the caller's company (and plant), for download. */
exports.getFile = async (req) => {
  const id = idOf(req.params.id, 'File not found.', 'FILE_NOT_FOUND');
  const { companyId, plantId } = scope(req);
  const { rows } = await pool.query(
    `SELECT ${FILE_COLUMNS}, f.company_id, f.folder, f.stored_name
       FROM program_files f
      WHERE f.id = $1 AND f.company_id = $2 AND f.deleted_at IS NULL${plantSql('f.machine_id', plantId, companyId)}`,
    [id, companyId]
  );
  if (!rows.length) throw fail('File not found.', 'FILE_NOT_FOUND', 404);
  return rows[0];
};

/**
 * Delete a file. Not the machine's program: deleting it would hand the
 * gateway the upload before it, and the machine would quietly go back to an
 * older program. Its row stays (deleted_at), so the audit still names it.
 */
exports.deleteFile = async (req) => {
  const file = await exports.getFile(req);
  const current = file.kind === 'NEW' ? await currentProgram(file.machine_id) : null;
  if (current?.id === file.id) {
    throw fail("This is the machine's program. Upload the next program first; then this one can be deleted.", 'CURRENT_PROGRAM', 409);
  }
  await storage.remove(file.folder, file.stored_name);
  await pool.query(`UPDATE program_files SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [file.id, req.user.id]);
  auditOf(req, { action: 'PROGRAM_DELETE', resource: 'program_file', resource_id: file.id,
                 old_value: { program: file.program_name, kind: file.kind, machine_id: file.machine_id } });
};

/**
 * Ask the machine's gateway for a backup. One open request per machine: a
 * second click while one waits returns that one. A request the gateway has
 * not answered within BACKUP_WAIT_MIN is closed, and a new one is made.
 */
exports.requestBackup = async (req) => {
  const machine = await getMachine(req, req.params.machineId);
  await pool.query(
    `UPDATE program_backup_requests SET closed_at = NOW()
      WHERE machine_id = $1 AND closed_at IS NULL AND requested_at <= NOW() - make_interval(mins => $2)`,
    [machine.id, BACKUP_WAIT_MIN]
  );
  const inserted = await pool.query(
    `INSERT INTO program_backup_requests (company_id, machine_id, requested_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (machine_id) WHERE closed_at IS NULL DO NOTHING
     RETURNING id, requested_at`,
    [machine.company_id, machine.id, req.user.id]
  );
  if (inserted.rows.length) {
    auditOf(req, { action: 'PROGRAM_BACKUP_REQUEST', resource: 'program_backup_request', resource_id: inserted.rows[0].id,
                   new_value: { machine: machine.machine_serial_no } });
    return { ...inserted.rows[0], created: true };
  }
  const { rows } = await pool.query(
    `SELECT id, requested_at FROM program_backup_requests WHERE machine_id = $1 AND closed_at IS NULL`, [machine.id]
  );
  return { ...rows[0], created: false };
};

/** The machine's gateway token: one live token per machine. Shown in this answer only, never stored. */
exports.createDeviceToken = async (req) => {
  const machine = await getMachine(req, req.params.machineId);
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
       VALUES ($1, $2, 'Gateway', $3, $4, $5)
       RETURNING id, token_prefix, created_at`,
      [machine.company_id, machine.id, prefix, hash, req.user.id]
    ));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  auditOf(req, { action: 'DEVICE_TOKEN_CREATE', resource: 'program_device', resource_id: device.id,
                 new_value: { machine: machine.machine_serial_no, token_prefix: prefix } });
  return { token, token_prefix: device.token_prefix, created_at: device.created_at, machine_serial_no: machine.machine_serial_no };
};

/** Stop the machine's gateway token at once (a lost laptop, a leaked token). */
exports.revokeDeviceToken = async (req) => {
  const machine = await getMachine(req, req.params.machineId);
  const { rows } = await pool.query(
    `UPDATE program_devices SET revoked_at = NOW(), revoked_by = $2
      WHERE machine_id = $1 AND revoked_at IS NULL RETURNING id, token_prefix`,
    [machine.id, req.user.id]
  );
  if (!rows.length) throw fail('This machine has no gateway token.', 'NO_TOKEN', 404);
  auditOf(req, { action: 'DEVICE_TOKEN_REVOKE', resource: 'program_device', resource_id: rows[0].id,
                 old_value: { machine: machine.machine_serial_no, token_prefix: rows[0].token_prefix } });
};

/* ───────────────────────── the machine's gateway ───────────────────────── */

const fileView = f => f && ({ file_id: Number(f.id), program_name: f.program_name, size_bytes: f.size_bytes,
                              sha256: f.sha256, uploaded_at: f.created_at });

/** The program as /status shows it: with what the gateway already reported, so it does not try a refused file again. */
const programView = f => f && ({ ...fileView(f), status: f.delivery_status || 'WAITING', message: f.delivery_message || null });

/** What the gateway polls: the machine's program (compare sha256 to know it changed) and an open backup request. */
exports.deviceStatus = async (device) => {
  const [program, request] = await Promise.all([
    currentProgram(device.machine.id),
    pool.query(
      `SELECT id, requested_at FROM program_backup_requests
        WHERE machine_id = $1 AND closed_at IS NULL AND requested_at > NOW() - make_interval(mins => $2)`,
      [device.machine.id, BACKUP_WAIT_MIN]
    )
  ]);
  const open = request.rows[0];
  return {
    machine: { id: Number(device.machine.id), serial: device.machine.machine_serial_no },
    program: programView(program),
    backup_request: open ? { id: Number(open.id), requested_at: open.requested_at } : null,
    poll_seconds: POLL_SECONDS
  };
};

exports.deviceProgram = async (device) => {
  const program = await currentProgram(device.machine.id);
  if (!program) throw fail('No program has been uploaded for this machine yet.', 'NO_PROGRAM', 404);
  return program;
};

/** A backup from the machine. It answers an open backup request, and the person who asked is told. */
exports.deviceBackup = async (device, staged, body = {}) => {
  const machine = { id: device.machine.id, company_id: device.company_id, machine_serial_no: device.machine.machine_serial_no };
  const file = await saveFile({ machine, kind: 'BACKUP', staged, programName: body.program_name, deviceId: device.id });
  const { rows: [request] } = await pool.query(
    `UPDATE program_backup_requests SET closed_at = NOW(), file_id = $2
      WHERE machine_id = $1 AND closed_at IS NULL
      RETURNING id, requested_by`,
    [machine.id, file.id]
  );
  if (request?.requested_by) {
    await tellUser(machine, request.requested_by, 'INFO', `Backup received — ${machine.machine_serial_no}`,
                   `"${file.program_name}" was saved from ${machine.machine_serial_no}.`, file.id);
  }
  return { file: fileView(file), answered_request: request ? Number(request.id) : null };
};

const REPORT_STATUSES = ['DONE', 'FAILED'];

/**
 * What happened, from the gateway:
 *   { file_id, status: DONE }              the program is on the machine
 *   { file_id, status: FAILED, message }   the machine refused it
 *   { backup_request_id, status: FAILED, message }  the backup could not be read
 * (A backup that worked is answered by POST /backup itself.) Reporting the
 * same thing twice — a retry after a lost answer — changes nothing and
 * notifies no one again.
 */
exports.deviceReport = async (device, body = {}) => {
  const machine = { id: device.machine.id, company_id: device.company_id, machine_serial_no: device.machine.machine_serial_no };
  const status = String(body.status || '').toUpperCase();
  const message = body.message == null ? null : String(body.message).trim().slice(0, 500) || null;
  if (!REPORT_STATUSES.includes(status)) throw fail('status must be DONE or FAILED.', 'BAD_STATUS');
  if (status === 'FAILED' && !message) throw fail('Say what went wrong in "message".', 'NO_MESSAGE');

  if (body.file_id != null) {
    const id = idOf(body.file_id, 'No such program for this machine.', 'FILE_NOT_FOUND');
    const { rows: [file] } = await pool.query(
      `UPDATE program_files SET delivery_status = $3, delivery_message = $4, delivered_at = NOW()
        WHERE id = $1 AND machine_id = $2 AND kind = 'NEW' AND deleted_at IS NULL
          AND (delivery_status IS DISTINCT FROM $3 OR delivery_message IS DISTINCT FROM $4)
        RETURNING id, program_name, uploaded_by`,
      [id, machine.id, status, status === 'DONE' ? null : message]
    );
    if (!file) {
      const known = await pool.query(
        `SELECT id FROM program_files WHERE id = $1 AND machine_id = $2 AND kind = 'NEW' AND deleted_at IS NULL`, [id, machine.id]
      );
      if (!known.rows.length) throw fail('No such program for this machine.', 'FILE_NOT_FOUND', 404);
      return { file_id: id, status, unchanged: true };
    }
    if (file.uploaded_by) {
      await (status === 'DONE'
        ? tellUser(machine, file.uploaded_by, 'INFO', `Program on ${machine.machine_serial_no}`,
                   `"${file.program_name}" was written to ${machine.machine_serial_no}.`, file.id)
        : tellUser(machine, file.uploaded_by, 'WARNING', `Program not accepted — ${machine.machine_serial_no}`,
                   `${machine.machine_serial_no} could not use "${file.program_name}": ${message}`, file.id));
    }
    return { file_id: id, status };
  }

  if (body.backup_request_id != null) {
    if (status !== 'FAILED') {
      throw fail('A backup that worked is answered by sending the file to POST /backup. Report only FAILED here.', 'BAD_STATUS');
    }
    const id = idOf(body.backup_request_id, 'No backup request with this id for this machine.', 'REQUEST_NOT_FOUND');
    const { rows: [request] } = await pool.query(
      `UPDATE program_backup_requests SET closed_at = NOW(), error_message = $3
        WHERE id = $1 AND machine_id = $2 AND closed_at IS NULL
        RETURNING id, requested_by`,
      [id, machine.id, message]
    );
    if (!request) {
      const known = await pool.query(`SELECT id FROM program_backup_requests WHERE id = $1 AND machine_id = $2`, [id, machine.id]);
      if (!known.rows.length) throw fail('No backup request with this id for this machine.', 'REQUEST_NOT_FOUND', 404);
      return { backup_request_id: id, status, unchanged: true };
    }
    if (request.requested_by) {
      await tellUser(machine, request.requested_by, 'WARNING', `Backup failed — ${machine.machine_serial_no}`,
                     `${machine.machine_serial_no} could not send a backup: ${message}`);
    }
    return { backup_request_id: id, status };
  }

  throw fail('Send file_id (a program) or backup_request_id (a backup request).', 'NOTHING_TO_REPORT');
};

/** Respects Settings → Program transfer notifications, like transfers always did. */
/** The link opens Program Transfer on this machine, the file marked (notifications/links.js). */
async function tellUser(machine, userId, type, title, message, fileId = null) {
  try {
    await pool.query(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (SELECT 1 FROM notification_preferences
                           WHERE user_id = $2 AND notify_program_transfer = false)`,
      [machine.company_id, userId, type, title, message, programLink(machine.id, fileId)]
    );
    await announceUnread([userId]);
  } catch (err) {
    console.error('Program transfer notification failed:', err.message);
  }
}

exports._internal = { ONLINE_WINDOW_SEC, BACKUP_WAIT_MIN, POLL_SECONDS, currentProgram };
