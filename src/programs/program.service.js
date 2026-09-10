const pool = require('../db');
/*
 * Transfers go through whichever protocol the machine speaks — FOCAS for
 * Fanuc, FTP for the rest — resolved per machine rather than imported
 * directly, so everything below this line is protocol-agnostic.
 */
const { transportFor, protocolFor } = require('./transports');
const { emitToUser } = require('../lib/realtime');
const { assertAuthorized } = require('./authorization.service');

/* ─────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────── */

/** Load a machine the caller is allowed to touch, or throw. */
async function getMachine(machineId, companyId) {
  // `controller` is what routes a machine to FOCAS or FTP, so it has to
  // travel with the row rather than being looked up again later.
  const { rows, rowCount } = await pool.query(
    `SELECT id, machine_serial_no, ip_address, ftp_port, ftp_user, ftp_pass, ftp_dir,
            controller
     FROM machines
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [machineId, companyId]
  );
  if (rowCount === 0) throw new Error('Machine not found or access denied');
  return rows[0];
}

/** Raise a 409 the frontend can turn into an overwrite prompt. */
function fileExistsError(fileName) {
  const e = new Error(`"${fileName}" already exists on the controller.`);
  e.status = 409;
  e.code = 'FILE_EXISTS';
  return e;
}

/* ─────────────────────────────────────────────────────────────
   One transfer at a time, per machine

   A CNC's embedded FTP server is not a general-purpose one: most
   accept a single control session, and a second connection either is
   refused or — worse on some Mitsubishi models — interleaves with the
   first and leaves a truncated file on the controller. Two operators
   sending to the same machine at the same moment is not a rare case;
   it is a Monday morning.

   The lock is a Postgres advisory lock rather than an in-process mutex
   because pm2 runs the API as multiple instances, and a JavaScript Map
   in one worker cannot see a transfer running in another. It is taken
   on its own pooled connection and released in a finally; if the
   process dies mid-transfer the session ends and Postgres drops the
   lock on its own, so a crash cannot wedge a machine permanently.
   ───────────────────────────────────────────────────────────── */

const TRANSFER_LOCK_NAMESPACE = 0x5052;   // 'PR' — program transfer

function machineBusyError(machine) {
  const e = new Error(
    `Another transfer to ${machine.machine_serial_no} is already running. ` +
    `Wait for it to finish and try again.`
  );
  e.status = 409;
  e.code = 'MACHINE_BUSY';
  return e;
}

async function withMachineLock(machine, fn) {
  const client = await pool.connect();
  try {
    const { rows: [{ locked }] } = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [TRANSFER_LOCK_NAMESPACE, machine.id]
    );
    if (!locked) throw machineBusyError(machine);

    try {
      return await fn();
    } finally {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        [TRANSFER_LOCK_NAMESPACE, machine.id]
      );
    }
  } finally {
    client.release();
  }
}

/* ─────────────────────────────────────────────────────────────
   Where the connection test may point

   testConnection accepts an address in the request body so the machine
   form can be tried before it is saved. That makes it, unguarded, a
   port scanner any logged-in user can drive: the server connects
   wherever it is told and reports back whether the port answered.
   On EC2 that includes 169.254.169.254, the instance metadata service.

   CNC controllers live on private shop-floor networks, so restricting
   the probe to RFC 1918 space costs nothing real and closes the hole.
   Only body-supplied addresses are checked — an address already stored
   on a machine row was set by an admin and is left alone.
   ───────────────────────────────────────────────────────────── */

function assertPrivateAddress(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
  const octets = m && m.slice(1).map(Number);

  if (!octets || octets.some(n => n > 255)) {
    const e = new Error(`"${ip}" is not a valid IPv4 address.`);
    e.status = 400;
    e.code = 'BAD_ADDRESS';
    return Promise.reject(e);
  }

  const [a, b] = octets;
  const isPrivate = a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);

  if (!isPrivate) {
    const e = new Error(
      `${ip} is not on a private network. CNC controllers must be reachable ` +
      `at a 10.x, 172.16–31.x or 192.168.x address.`
    );
    e.status = 400;
    e.code = 'ADDRESS_NOT_PRIVATE';
    return Promise.reject(e);
  }
  return Promise.resolve();
}

/**
 * Supervisor authorisation travels in the body alongside `overwrite`,
 * so the overwrite retry — which re-sends the whole batch — carries the
 * same code and never re-prompts the supervisor.
 */
function authFromRequest(req) {
  return {
    authorization_id: req.body?.authorization_id,
    code: req.body?.authorization_code
  };
}

/**
 * Error codes that deserve their own per-row status in a batch result
 * rather than being flattened into FAILED. Each one has a distinct fix:
 * overwrite it, enter a code, or ask an admin to assign a supervisor.
 */
const BATCH_ROW_STATUS = {
  FILE_EXISTS:            'EXISTS',
  EXISTENCE_UNKNOWN:      'EXISTS',        // same fix: confirm the overwrite
  MACHINE_BUSY:           'BUSY',
  NOT_CONFIGURED:         'NOT_CONFIGURED',
  BAD_DIRECTORY:          'NOT_CONFIGURED',
  EMPTY_PROGRAM:          'FAILED',
  BACKUP_FAILED:          'BACKUP_FAILED',   // nothing was sent; the old program is intact
  APPROVAL_REQUIRED:      'APPROVAL_REQUIRED',
  NO_SUPERVISOR_ASSIGNED: 'NO_SUPERVISOR',
  INVALID_CODE:           'APPROVAL_REQUIRED',
  CODE_EXPIRED:           'APPROVAL_REQUIRED',
  CODE_LOCKED:            'APPROVAL_REQUIRED',
  CODE_EXHAUSTED:         'APPROVAL_REQUIRED',
  WRONG_MACHINE:          'APPROVAL_REQUIRED'
};

/**
 * Notify the user who ran the transfer. Best-effort: a failure to write
 * the notification must never mask the transfer result itself.
 */
async function notifyTransfer({ companyId, userId, ok, direction, programName, machineSerial, reason, backupName }) {
  const verb = direction === 'DOWNLOAD' ? 'received from' : 'sent to';
  const title = ok
    ? `Program ${verb} ${machineSerial}`
    : `Program transfer failed — ${machineSerial}`;
  const message = ok
    ? `"${programName}" was ${verb} ${machineSerial}.` +
      (backupName ? ` The program it replaced was saved as "${backupName}".` : '')
    : `"${programName}" could not be ${direction === 'DOWNLOAD' ? 'received from' : 'sent to'} ${machineSerial}. ${reason || ''}`.trim();

  try {
    await pool.query(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, userId, ok ? 'INFO' : 'WARNING', title, message, '/programs']
    );
  } catch (err) {
    console.error('Transfer notification failed:', err.message);
  }
}

/** Stream byte-level progress to the initiating user's open tabs. */
function progressEmitter(userId, transferId, fileName, direction) {
  return ({ bytes, total }) => {
    emitToUser(userId, 'programTransferProgress', {
      transfer_id: transferId,
      file_name:   fileName,
      direction,
      bytes,
      total,
      percent: total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : null
    });
  };
}

/* ─────────────────────────────────────────────────────────────
   Programs stored on the server
   ───────────────────────────────────────────────────────────── */

/* UPLOAD PROGRAM (G-code / NC file) */
exports.createProgram = async (req) => {
  if (!req.file) {
    throw new Error('No program file uploaded');
  }

  const { name, description } = req.body;
  const file = req.file;

  const result = await pool.query(
    `INSERT INTO programs (company_id, name, file_name, content, file_size, description, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, file_name, file_size, description, created_at`,
    [
      req.user.company_id,
      name || file.originalname,
      file.originalname,
      file.buffer,
      file.size,
      description || null,
      req.user.id
    ]
  );

  return result.rows[0];
};

/* LIST PROGRAMS */
exports.getPrograms = async (req) => {
  const { search = '', page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;
  const values = [req.user.company_id];

  // Backups are excluded: this list is what an operator picks from to send,
  // and one row per overwrite would bury the programs they actually curate.
  // They are listed by getBackups instead, per machine, where they mean
  // something.
  let whereSQL = `WHERE p.company_id = $1 AND p.is_active = true AND p.is_backup = false`;
  if (search) {
    values.push(`%${search}%`);
    whereSQL += ` AND (p.name ILIKE $${values.length} OR p.file_name ILIKE $${values.length})`;
  }

  const dataQuery = `
    SELECT p.id, p.name, p.file_name, p.file_size, p.description, p.created_at,
           u.username AS uploaded_by_name
    FROM programs p
    LEFT JOIN users u ON u.id = p.uploaded_by
    ${whereSQL}
    ORDER BY p.created_at DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `;

  const countQuery = `SELECT COUNT(*)::int AS total FROM programs p ${whereSQL}`;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [...values, limit, offset]),
    pool.query(countQuery, values)
  ]);

  return { data: dataRes.rows, total: countRes.rows[0].total };
};

/* DOWNLOAD PROGRAM FILE */
exports.getProgramFile = async (req) => {
  const result = await pool.query(
    `SELECT file_name, content FROM programs
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [req.params.id, req.user.company_id]
  );
  if (result.rowCount === 0) {
    throw new Error('Program not found or access denied');
  }
  return result.rows[0];
};

/* DELETE PROGRAM (soft delete — transfer history keeps its name) */
exports.deleteProgram = async (req) => {
  const result = await pool.query(
    `UPDATE programs SET is_active = false
     WHERE id = $1 AND company_id = $2
     RETURNING id`,
    [req.params.id, req.user.company_id]
  );
  if (result.rowCount === 0) {
    throw new Error('Program not found or access denied');
  }
};

/* ─────────────────────────────────────────────────────────────
   Programs living on the controller
   ───────────────────────────────────────────────────────────── */

/* BROWSE FILES ON THE CNC */
exports.listMachinePrograms = async (req) => {
  const machine = await getMachine(req.params.machineId, req.user.company_id);
  const files = await transportFor(machine).listMachineFiles(machine);

  const { search = '' } = req.query;
  const term = String(search).trim().toLowerCase();
  return term
    ? files.filter(f => f.name.toLowerCase().includes(term))
    : files;
};

/* CONNECTION STATUS — one machine, for the live indicator */
exports.getMachineStatus = async (req) => {
  const machine = await getMachine(req.params.machineId, req.user.company_id);
  // Report the protocol alongside the status: "offline" means something
  // different for FOCAS (port 8193, licensed option) than for FTP, and
  // whoever is diagnosing it needs to know which one was tried.
  const protocol = protocolFor(machine);
  try {
    await transportFor(machine).testMachineConnection(machine);
    return { machine_id: machine.id, online: true, protocol };
  } catch (err) {
    return { machine_id: machine.id, online: false, protocol, reason: err.message };
  }
};

/* ─────────────────────────────────────────────────────────────
   Transfers
   ───────────────────────────────────────────────────────────── */

/**
 * Send one stored program to one machine.
 * Shared by the single and batch endpoints so both log and notify
 * identically.
 */
async function uploadOne({ program, machine, user, overwrite, auth, verified }) {
  // Supervisor sign-off comes first — before the machine lock and the FTP
  // probe, so an unauthorised caller never opens a session against the
  // controller and never blocks a legitimate transfer by holding the lock.
  // The guard lives here rather than in route middleware because both
  // the single and batch endpoints funnel through this function, so
  // there is no path to a machine that can skip it.
  //
  // `verified` is only ever supplied by transferBatch, which checks the
  // code once per machine. Without it every program in a batch would be a
  // separate verification, so one mistyped digit across five selected
  // programs would burn five of the five attempts and lock the code
  // outright. Absent it, this verifies for itself.
  const authorization = verified || await assertAuthorized(machine, user, auth);

  return withMachineLock(machine, () =>
    uploadOneLocked({ program, machine, user, overwrite, authorization })
  );
}

/* ─────────────────────────────────────────────────────────────
   Back up what is on the machine before replacing it

   A program sitting on a controller is not necessarily a copy of anything
   in the library. Operators edit at the panel — feeds, speeds, offsets
   tuned against the actual part — and those edits usually exist nowhere
   else. Overwriting on a confirmation dialog alone means the only copy of
   that work is gone the moment someone clicks through.

   So the old program is read off the machine and stored first. It is
   stored as an ordinary program row, flagged is_backup, which means it can
   be sent straight back if the new one turns out to be wrong. That is the
   whole reason to keep it, and a shape that could not be sent back would
   be a museum piece.
   ───────────────────────────────────────────────────────────── */

function backupFailedError(fileName, reason) {
  const e = new Error(
    `Could not back up "${fileName}" from the machine, so nothing was sent. ${reason}`
  );
  e.status = 502;
  e.code = 'BACKUP_FAILED';
  return e;
}

/**
 * Read the program currently on the machine and store it as a backup.
 * Runs inside the machine lock, between the existence check and the send.
 *
 * @returns {Promise<{id: number, name: string, file_size: number}>}
 */
async function backupBeforeOverwrite({ machine, program, user, transport }) {
  let content;
  try {
    content = await transport.fetchProgramFromMachine(machine, program.file_name);
  } catch (err) {
    // Refusing to continue is the point. Sending anyway would destroy the
    // very thing the backup exists to protect, and the operator would have
    // no way of knowing until they went looking for it.
    throw backupFailedError(program.file_name, err.message);
  }

  if (!content || content.length === 0) {
    throw backupFailedError(program.file_name, 'The machine returned an empty program.');
  }

  const takenAt = new Date();
  const label = takenAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

  const { rows: [row] } = await pool.query(
    `INSERT INTO programs
       (company_id, name, file_name, content, file_size, description, uploaded_by,
        source, is_backup, backup_of_machine_id, backup_of_program_id, backup_taken_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'CNC',TRUE,$8,$9,$10)
     RETURNING id, name, file_size`,
    [
      user.company_id,
      `${program.file_name} — ${machine.machine_serial_no} backup ${label}`,
      program.file_name,
      content,
      content.length,
      `Read from ${machine.machine_serial_no} before "${program.name}" replaced it.`,
      user.id,
      machine.id,
      program.id,
      takenAt
    ]
  );

  return row;
}

/** The transfer itself. Only ever called holding the machine's lock. */
async function uploadOneLocked({ program, machine, user, overwrite, authorization }) {
  const companyId = user.company_id;
  const transport = transportFor(machine);

  const exists = await transport.machineFileExists(machine, program.file_name);
  if (exists && !overwrite) {
    throw fileExistsError(program.file_name);
  }

  // Read the old program off the machine before replacing it. Still inside
  // the machine lock, so nothing can write between the backup and the send.
  const backup = exists
    ? await backupBeforeOverwrite({ machine, program, user, transport })
    : null;

  // log first so an interrupted transfer still leaves a trace
  const { rows: [{ id: transferId }] } = await pool.query(
    `INSERT INTO program_transfers
       (company_id, program_id, machine_id, program_name, file_name, machine_serial,
        direction, file_size, status, transferred_by,
        authorized_by, authorization_id, authorized_at, backup_program_id)
     VALUES ($1,$2,$3,$4,$5,$6,'UPLOAD',$7,'PENDING',$8,$9,$10,NOW(),$11)
     RETURNING id`,
    [companyId, program.id, machine.id, program.name, program.file_name,
     machine.machine_serial_no, program.content?.length || null, user.id,
     authorization.supervisor_id, authorization.id, backup?.id ?? null]
  );

  try {
    await transport.sendProgramToMachine(
      machine, program.content, program.file_name,
      progressEmitter(user.id, transferId, program.file_name, 'UPLOAD')
    );

    await pool.query(
      `UPDATE program_transfers SET status = 'SUCCESS', finished_at = NOW() WHERE id = $1`,
      [transferId]
    );
    await notifyTransfer({
      companyId, userId: user.id, ok: true, direction: 'UPLOAD',
      programName: program.name, machineSerial: machine.machine_serial_no,
      backupName: backup?.name
    });

    return {
      transfer_id: transferId,
      status: 'SUCCESS',
      // The UI says so explicitly — an operator who knows the old program
      // was kept will overwrite when they should, and go looking for it
      // when they need to.
      backup: backup ? { id: backup.id, name: backup.name, file_size: backup.file_size } : null
    };
  } catch (err) {
    await pool.query(
      `UPDATE program_transfers SET status = 'FAILED', error_message = $2, finished_at = NOW() WHERE id = $1`,
      [transferId, err.message]
    );
    await notifyTransfer({
      companyId, userId: user.id, ok: false, direction: 'UPLOAD',
      programName: program.name, machineSerial: machine.machine_serial_no, reason: err.message
    });

    // Keep the original code so a batch row can say "fix the config" or
    // "confirm the overwrite" rather than a flat FAILED.
    const e = new Error(`Transfer failed: ${err.message}`);
    e.status = err.status || 502;
    e.code = err.code;
    throw e;
  }
}

/** Load a stored program with its bytes, or throw. */
async function getProgram(programId, companyId) {
  const { rows, rowCount } = await pool.query(
    `SELECT id, name, file_name, content FROM programs
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [programId, companyId]
  );
  if (rowCount === 0) throw new Error('Program not found or access denied');
  return rows[0];
}

/* TRANSFER PROGRAM TO MACHINE via FTP */
exports.transferProgram = async (req) => {
  const { id: programId, machineId } = req.params;
  const overwrite = req.body?.overwrite === true || req.query?.overwrite === 'true';
  const auth = authFromRequest(req);

  const [program, machine] = await Promise.all([
    getProgram(programId, req.user.company_id),
    getMachine(machineId, req.user.company_id)
  ]);

  return uploadOne({ program, machine, user: req.user, overwrite, auth });
};

/**
 * BATCH TRANSFER — any number of programs to any number of machines.
 * One machine failing must not abort the rest, so every combination is
 * attempted and reported individually.
 */
exports.transferBatch = async (req) => {
  const { program_ids = [], machine_ids = [], overwrite = false } = req.body || {};
  const auth = authFromRequest(req);

  if (!Array.isArray(program_ids) || program_ids.length === 0) {
    throw new Error('Select at least one program to transfer');
  }
  if (!Array.isArray(machine_ids) || machine_ids.length === 0) {
    throw new Error('Select at least one machine to transfer to');
  }

  const companyId = req.user.company_id;
  const [programs, machines] = await Promise.all([
    Promise.all(program_ids.map(id => getProgram(id, companyId))),
    Promise.all(machine_ids.map(id => getMachine(id, companyId)))
  ]);

  const results = [];
  for (const machine of machines) {
    // Authorise once per machine, not once per program. Each machine still
    // needs its own supervisor's code, so a batch spanning two machines
    // fails cleanly on the one it has no authorisation for.
    let verified;
    try {
      verified = await assertAuthorized(machine, req.user, auth);
    } catch (err) {
      for (const program of programs) {
        results.push({
          program_id: program.id, program_name: program.name,
          machine_id: machine.id, machine_serial: machine.machine_serial_no,
          status: BATCH_ROW_STATUS[err.code] || 'FAILED',
          code: err.code, message: err.message
        });
      }
      continue;
    }

    for (const program of programs) {
      try {
        const r = await uploadOne({ program, machine, user: req.user, overwrite, verified });
        results.push({
          program_id: program.id, program_name: program.name,
          machine_id: machine.id, machine_serial: machine.machine_serial_no,
          status: 'SUCCESS', transfer_id: r.transfer_id,
          // so the UI can tell the operator their old program was kept
          backup: r.backup
        });
      } catch (err) {
        // A batch can span machines with different supervisors, so an
        // authorisation failure has to be reported per combination —
        // collapsing it into FAILED would show "3 of 4 transfers failed"
        // with no hint that the fix is a code, not a retry.
        results.push({
          program_id: program.id, program_name: program.name,
          machine_id: machine.id, machine_serial: machine.machine_serial_no,
          status: BATCH_ROW_STATUS[err.code] || 'FAILED',
          code: err.code, message: err.message
        });
      }
    }
  }

  const succeeded = results.filter(r => r.status === 'SUCCESS').length;
  return { total: results.length, succeeded, failed: results.length - succeeded, results };
};

/**
 * PULL A PROGRAM OFF THE CONTROLLER into the server library.
 * Requirement: "download programs from the CNC Controller to the Local PC".
 */
exports.fetchFromMachine = async (req) => {
  const { machineId } = req.params;
  const { file_name } = req.body || {};
  if (!file_name) throw new Error('file_name is required');

  const companyId = req.user.company_id;
  const machine = await getMachine(machineId, companyId);

  // Same single-session constraint as an upload — a fetch running while
  // a send is in flight would be a second control connection.
  return withMachineLock(machine, () => fetchLocked(machine, file_name, req.user));
};

async function fetchLocked(machine, file_name, user) {
  const companyId = user.company_id;

  const { rows: [{ id: transferId }] } = await pool.query(
    `INSERT INTO program_transfers
       (company_id, machine_id, program_name, file_name, machine_serial,
        direction, status, transferred_by)
     VALUES ($1,$2,$3,$4,$5,'DOWNLOAD','PENDING',$6)
     RETURNING id`,
    [companyId, machine.id, file_name, file_name, machine.machine_serial_no, user.id]
  );

  try {
    const content = await transportFor(machine).fetchProgramFromMachine(
      machine, file_name,
      progressEmitter(user.id, transferId, file_name, 'DOWNLOAD')
    );

    const { rows: [program] } = await pool.query(
      `INSERT INTO programs
         (company_id, name, file_name, content, file_size, description, uploaded_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'CNC')
       RETURNING id, name, file_name, file_size, created_at`,
      [companyId, file_name, file_name, content, content.length,
       `Retrieved from ${machine.machine_serial_no}`, user.id]
    );

    await pool.query(
      `UPDATE program_transfers
       SET status='SUCCESS', finished_at=NOW(), program_id=$2, file_size=$3
       WHERE id=$1`,
      [transferId, program.id, content.length]
    );
    await notifyTransfer({
      companyId, userId: user.id, ok: true, direction: 'DOWNLOAD',
      programName: file_name, machineSerial: machine.machine_serial_no
    });

    return { transfer_id: transferId, status: 'SUCCESS', program };
  } catch (err) {
    await pool.query(
      `UPDATE program_transfers SET status = 'FAILED', error_message = $2, finished_at = NOW() WHERE id = $1`,
      [transferId, err.message]
    );
    await notifyTransfer({
      companyId, userId: user.id, ok: false, direction: 'DOWNLOAD',
      programName: file_name, machineSerial: machine.machine_serial_no, reason: err.message
    });

    // Preserve the original code (BAD_DIRECTORY, NOT_CONFIGURED, …) so the
    // UI can tell a misconfiguration from an unreachable machine.
    const e = new Error(`Download failed: ${err.message}`);
    e.status = err.status || 502;
    e.code = err.code;
    throw e;
  }
}

/* BACKUPS TAKEN OFF A MACHINE
   The answer to "what was on this machine before we changed it?" — which is
   asked when a new program is behaving wrong and someone needs the previous
   one back on the controller now, not after a search through the library. */
exports.getBackups = async (req) => {
  const { machine_id, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const values = [req.user.company_id];

  let whereSQL = `WHERE p.company_id = $1 AND p.is_active = true AND p.is_backup = true`;
  if (machine_id) {
    values.push(machine_id);
    whereSQL += ` AND p.backup_of_machine_id = $${values.length}`;
  }

  const dataQuery = `
    SELECT p.id, p.name, p.file_name, p.file_size, p.backup_taken_at,
           p.backup_of_machine_id, m.machine_serial_no,
           u.username AS taken_by_name,
           r.name AS replaced_by_program_name
    FROM programs p
    LEFT JOIN machines m ON m.id = p.backup_of_machine_id
    LEFT JOIN users    u ON u.id = p.uploaded_by
    LEFT JOIN programs r ON r.id = p.backup_of_program_id
    ${whereSQL}
    ORDER BY p.backup_taken_at DESC, p.id DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `;

  const countQuery = `SELECT COUNT(*)::int AS total FROM programs p ${whereSQL}`;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [...values, limit, offset]),
    pool.query(countQuery, values)
  ]);

  return { data: dataRes.rows, total: countRes.rows[0].total };
};

/* TRANSFER HISTORY */
exports.getTransfers = async (req) => {
  const { page = 1, limit = 20, machine_id, direction } = req.query;
  const offset = (page - 1) * limit;
  const values = [req.user.company_id];

  let whereSQL = `WHERE t.company_id = $1`;
  if (machine_id) {
    values.push(machine_id);
    whereSQL += ` AND t.machine_id = $${values.length}`;
  }
  if (direction) {
    values.push(String(direction).toUpperCase());
    whereSQL += ` AND t.direction = $${values.length}`;
  }

  const dataQuery = `
    SELECT t.id, t.program_name, t.file_name, t.machine_serial, t.status,
           t.direction, t.file_size, t.error_message, t.started_at, t.finished_at,
           t.authorized_at, t.backup_program_id,
           u.username AS transferred_by_name,
           s.username AS authorized_by_name,
           b.name     AS backup_program_name
    FROM program_transfers t
    LEFT JOIN users u ON u.id = t.transferred_by
    LEFT JOIN users s ON s.id = t.authorized_by
    LEFT JOIN programs b ON b.id = t.backup_program_id
    ${whereSQL}
    ORDER BY t.started_at DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `;

  const countQuery = `SELECT COUNT(*)::int AS total FROM program_transfers t ${whereSQL}`;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [...values, limit, offset]),
    pool.query(countQuery, values)
  ]);

  return { data: dataRes.rows, total: countRes.rows[0].total };
};

/* TEST FTP CONNECTION
   Accepts FTP details in the body so the machine form can test unsaved
   values. When machine_id is given and a field is blank, falls back to
   the stored value — the password is never sent to the frontend (it is
   write-only), so a blank password means "use the saved one". */
exports.testConnection = async (req) => {
  const { machine_id, ip_address, ftp_port, ftp_user, ftp_pass } = req.body || {};

  // Only an address typed into this request is checked; a stored one was
  // set by an admin through the machine form and is trusted as-is.
  if (ip_address) await assertPrivateAddress(ip_address);

  let config = { ip_address, ftp_port, ftp_user, ftp_pass };

  if (machine_id) {
    const result = await pool.query(
      `SELECT ip_address, ftp_port, ftp_user, ftp_pass
       FROM machines
       WHERE id = $1 AND company_id = $2`,
      [machine_id, req.user.company_id]
    );
    if (result.rowCount === 0) throw new Error('Machine not found or access denied');
    const stored = result.rows[0];
    config = {
      ip_address: ip_address || stored.ip_address,
      ftp_port:   ftp_port   || stored.ftp_port,
      ftp_user:   ftp_user   || stored.ftp_user,
      ftp_pass:   ftp_pass   || stored.ftp_pass
    };
  }

  await transportFor(config).testMachineConnection(config);
};

/* MARK STUCK 'PENDING' TRANSFERS AS FAILED
   FTP transfers time out after 30s; anything PENDING for over 5 minutes
   means the server restarted or the connection hung mid-transfer.
   Called by the cron scheduler every 10 minutes. */
exports.cleanupStuckTransfers = async () => {
  const result = await pool.query(
    `UPDATE program_transfers
     SET status = 'FAILED',
         error_message = 'Transfer interrupted — server restarted or connection hung',
         finished_at = NOW()
     WHERE status = 'PENDING'
       AND started_at < NOW() - INTERVAL '5 minutes'
     RETURNING id`
  );
  return result.rowCount;
};
