/**
 * Program Transfer — kept simple (21 Oct 2026, the user: "just API, don't
 * complicate"), with one gateway per company (22 Oct 2026: "one token for
 * all machines … less load, fewer server hits"; the token is made by S&T).
 *
 *   People (/api/programs, signed in):
 *     pick a machine of their company, upload a program, download any file,
 *     delete one, ask the machine for a backup.
 *   S&T Super Admin (/api/companies/:id/program-gateway):
 *     make, replace or stop a company's gateway token.
 *   The company's gateway (/api/device/v1, that token):
 *     GET  /status   every machine in one answer: its machine_id, name, IP,
 *                    controller and its type, api_key and program path, the next program
 *                    waiting for it, and whether someone asked for a backup
 *     GET  /program  ?machine_id=ID: that machine's next program
 *     POST /backup   a backup file from a machine (form field "machine_id")
 *     POST /report   what happened: the program is on the machine, the
 *                    machine refused it, or a backup could not be read
 *
 * Programs wait in line, per machine: the gateway is offered the machine's
 * oldest upload it has not reported on; once it reports that one DONE or
 * FAILED, the next is offered. How the gateway talks to the CNC (FTP,
 * FOCAS, a USB stick…) is the gateway team's business: the server never
 * connects to a machine.
 *
 * Nothing moves for a machine in alarm, in emergency stop or disconnected
 * (27 Oct 2026, the user: "program transfer must not work then; show the
 * machine's status"): people cannot upload for it or ask it for a backup,
 * and the gateway is offered neither until it is running or idle again.
 *
 * Files are rows in program_files (030), kind NEW (an upload) or BACKUP. An
 * upload's place in line is its delivery_status (051, 053): NULL waiting,
 * then DONE or FAILED as reported, or SKIPPED (made before the line existed;
 * never sent); sent_to_gateway_at (059) is when GET /program last handed it
 * out, so the page can tell "waiting for the gateway" from "the gateway has
 * it, no report yet". Backup requests are program_backup_requests (050), one
 * open per machine; one the gateway leaves unanswered for BACKUP_WAIT_MIN is
 * no longer offered, and the page says so. The token is
 * program_gateway_tokens (053), one live per company.
 */
const pool = require('../db');
const storage = require('./storage');
const deviceToken = require('./device-token');
const audit = require('../audit/audit.service');
const { announceUnread } = require('../notifications/notification.service');
const { programLink } = require('../notifications/links');
const { plantSql } = require('../lib/read-scope');
const { effectivePlantId } = require('../lib/plant-scope');

/** A gateway is "online" when it called within this long. */
const ONLINE_WINDOW_SEC = 60;
/** A backup request the gateway has not answered by then is no longer offered to it, and can be asked again. */
const BACKUP_WAIT_MIN = 30;
/** A program with the gateway this long without a report is flagged on the page: the ones after it wait. */
const REPORT_WAIT_MIN = 10;
/** How often a gateway is asked to call /status. */
const POLL_SECONDS = 15;
/** A machine that sent no telemetry for this long is disconnected, as the Live Dashboard says (dashboard/fleet-page.js). */
const MACHINE_LIVE_SEC = 60;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/*
 * What a machine is doing now, from its telemetry, as the Live Dashboard
 * reads it: OFFLINE when it sent nothing for MACHINE_LIVE_SEC, else ALARM
 * while it alarms (EMERGENCY when an emergency stop is among its open
 * alarms), else RUNNING or IDLE. `m` is the machine; the bounded read lets
 * TimescaleDB look at the last hour's chunks only.
 */
const STATE_JOINS = `
         LEFT JOIN LATERAL (
                SELECT t.machine_status, t.alarm, t.received_at FROM telemetry_raw t
                 WHERE t.company_id = m.company_id AND t.machine_id = m.id
                   AND t.received_at > NOW() - INTERVAL '1 hour'
                 ORDER BY t.received_at DESC LIMIT 1) live ON true
         LEFT JOIN LATERAL (
                SELECT true AS emergency FROM machine_alarms a
                 WHERE a.machine_id = m.id AND a.ended_at IS NULL
                   AND (a.alarm_type ILIKE '%emergenc%' OR a.message ILIKE '%emergenc%')
                 LIMIT 1) emg ON true`;
const STATE = `CASE
           WHEN live.received_at IS NULL OR live.received_at < NOW() - make_interval(secs => ${MACHINE_LIVE_SEC}) THEN 'OFFLINE'
           WHEN live.alarm AND emg.emergency THEN 'EMERGENCY'
           WHEN live.alarm THEN 'ALARM'
           WHEN UPPER(live.machine_status) IN ('RUN', 'RUNNING', 'CUTTING') THEN 'RUNNING'
           ELSE 'IDLE' END`;

/** The states in which nothing moves for a machine, and how a sentence says so. */
const HOLD = {
  ALARM: 'is in alarm',
  EMERGENCY: 'is in emergency stop',
  OFFLINE: 'is disconnected: MEXA has had no data from it for a minute'
};
const onHold = state => Object.hasOwn(HOLD, String(state));
const holdError = machine => fail(
  `${machine.machine_serial_no} ${HOLD[machine.machine_state]}. Program transfer is off until it is running or idle again.`,
  'MACHINE_ON_HOLD', 409);

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

/** A switched-on machine of the caller's company (and plant, for a plant user), with its state now; or a 404. */
async function getMachine(req, machineId) {
  const id = idOf(machineId, 'Machine not found.', 'MACHINE_NOT_FOUND');
  const { companyId, plantId } = scope(req);
  const { rows } = await pool.query(
    `SELECT m.id, m.company_id, m.machine_serial_no, ${STATE} AS machine_state
       FROM machines m${STATE_JOINS}
      WHERE m.id = $1 AND m.company_id = $2 AND m.is_active = true${plantSql('m.id', plantId, companyId)}`,
    [id, companyId]
  );
  if (!rows.length) throw fail('Machine not found.', 'MACHINE_NOT_FOUND', 404);
  return rows[0];
}

/** As getMachine, for sending a program or asking a backup: a machine in alarm, emergency stop or disconnected is a 409 that says so. */
async function readyMachine(req, machineId) {
  const machine = await getMachine(req, machineId);
  if (onHold(machine.machine_state)) throw holdError(machine);
  return machine;
}

const FILE_COLUMNS = `f.id, f.machine_id, f.program_name, f.kind, f.size_bytes, f.sha256, f.created_at,
  f.delivery_status, f.delivery_message, f.delivered_at, f.sent_to_gateway_at`;

/** An upload still in line for its machine: not reported on, not deleted. */
const WAITING = `f.kind = 'NEW' AND f.delivery_status IS NULL AND f.deleted_at IS NULL`;

/** The machine's address as MEXA knows it: the controller's, from its telemetry (else the one typed in long ago). */
const MACHINE_IP = `COALESCE(NULLIF(btrim(m.controller_ip), ''), NULLIF(btrim(m.ip_address), ''))`;

/** The program a machine gets next: its oldest upload still in line. `ready`: none while the machine is on hold. */
async function nextProgram(machineId, db = pool, { ready = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${FILE_COLUMNS}, f.folder, f.stored_name
       FROM program_files f${ready ? `
       JOIN machines m ON m.id = f.machine_id${STATE_JOINS}` : ''}
      WHERE f.machine_id = $1 AND ${WAITING}${ready ? ` AND ${STATE} IN ('RUNNING', 'IDLE')` : ''}
      ORDER BY f.created_at, f.id
      LIMIT 1`,
    [machineId]
  );
  return rows[0] || null;
}

async function saveFile({ machine, kind, staged, programName, userId = null, gatewayId = null }) {
  if (!staged) throw fail('Attach the program file as "file".', 'NO_FILE');
  const saved = await storage.saveStream({
    machine, kind, programName: programName || staged.originalname, filename: staged.path
  });
  try {
    const { rows } = await pool.query(
      `INSERT INTO program_files (company_id, machine_id, folder, stored_name, program_name, kind, size_bytes, sha256, uploaded_by, gateway_token_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, machine_id, program_name, kind, size_bytes, sha256, created_at`,
      [machine.company_id, machine.id, saved.folder, saved.storedName, saved.programName, kind,
       saved.size, saved.sha256, userId, gatewayId]
    );
    return rows[0];
  } catch (err) {
    await storage.remove(saved.folder, saved.storedName).catch(() => {});   // no file without its row
    throw err;
  }
}

const auditOf = (req, entry) => audit.log({ user_id: req.user.id, company_id: req.user.company_id,
                                            ip_address: req.ip, user_agent: req.headers?.['user-agent'], ...entry });

/** The company's live gateway token, as a page shows it (S&T also sees where it calls from). */
async function liveGateway(companyId, { full = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, token_prefix, created_at, last_seen_at, last_seen_ip, agent_version,
            COALESCE(last_seen_at > NOW() - make_interval(secs => $2), false) AS online
       FROM program_gateway_tokens
      WHERE company_id = $1 AND revoked_at IS NULL`,
    [companyId, ONLINE_WINDOW_SEC]
  );
  const g = rows[0];
  if (!g) return null;
  const view = { token_prefix: g.token_prefix, token_created_at: g.created_at, last_seen_at: g.last_seen_at || null, online: !!g.online };
  return full ? { ...view, last_seen_ip: g.last_seen_ip || null, agent_version: g.agent_version || null } : view;
}

/* ───────────────────────── people ───────────────────────── */

/**
 * The last backup asked for came to nothing — the gateway could not read it,
 * or did not answer while it was offered — and no backup has arrived since.
 */
function backupFailure(r) {
  if (!r.request_id || r.request_waiting) return null;
  if (r.request_error) {
    // a backup sent after it (unasked) makes it old news
    return r.backup_at && new Date(r.backup_at) > new Date(r.request_closed_at) ? null : { message: r.request_error, at: r.request_closed_at };
  }
  // still open but no longer offered; any backup would have closed it, so none came
  if (!r.request_closed_at) {
    return { message: `No answer from the gateway within ${BACKUP_WAIT_MIN} minutes. Check that it is running, then ask again.`,
             at: r.requested_at, unanswered: true };
  }
  return null;
}

/**
 * The company's gateway, and its machines: each with what it is doing now
 * (on hold — in alarm, emergency stop or disconnected — nothing moves for
 * it; 27 Oct 2026), where its programs go (the program path, IP and
 * controller type the gateway is given — shown so a wrong one is seen;
 * 23 Oct 2026), the program in front of its line, how many wait and whether
 * the gateway has taken it, the last program the gateway reported on (on the
 * machine, or refused), its last backup, and what became of the last backup
 * asked for.
 */
exports.listMachines = async (req) => {
  const { companyId, plantId } = scope(req);
  const [{ rows }, gateway] = await Promise.all([
    pool.query(
      `SELECT m.id, m.machine_serial_no, m.program_path, m.controller_type, ${MACHINE_IP} AS machine_ip,
              ${STATE} AS machine_state, live.received_at AS last_seen_at,
              q.id AS next_id, q.program_name AS next_name, q.size_bytes AS next_size, q.created_at AS next_at, q.waiting,
              q.sent_to_gateway_at AS next_sent_at,
              COALESCE(q.sent_to_gateway_at <= NOW() - make_interval(mins => $3), false) AS next_report_late,
              p.id AS report_id, p.program_name AS report_name, p.delivery_status, p.delivery_message, p.delivered_at,
              b.id AS backup_id, b.program_name AS backup_name, b.created_at AS backup_at,
              lr.id AS request_id, lr.requested_at, lr.closed_at AS request_closed_at, lr.error_message AS request_error,
              COALESCE(lr.closed_at IS NULL AND lr.requested_at > NOW() - make_interval(mins => $2), false) AS request_waiting
         FROM machines m${STATE_JOINS}
         LEFT JOIN LATERAL (
                SELECT f.id, f.program_name, f.size_bytes, f.created_at, f.sent_to_gateway_at, COUNT(*) OVER () AS waiting
                  FROM program_files f
                 WHERE f.machine_id = m.id AND ${WAITING}
                 ORDER BY f.created_at, f.id LIMIT 1) q ON true
         LEFT JOIN LATERAL (
                SELECT f.id, f.program_name, f.delivery_status, f.delivery_message, f.delivered_at
                  FROM program_files f
                 WHERE f.machine_id = m.id AND f.kind = 'NEW' AND f.delivery_status IN ('DONE', 'FAILED') AND f.deleted_at IS NULL
                 ORDER BY f.delivered_at DESC NULLS LAST, f.id DESC LIMIT 1) p ON true
         LEFT JOIN LATERAL (
                SELECT id, program_name, created_at FROM program_files
                 WHERE machine_id = m.id AND kind IN ('BACKUP', 'FETCHED') AND deleted_at IS NULL
                 ORDER BY created_at DESC, id DESC LIMIT 1) b ON true
         LEFT JOIN LATERAL (
                SELECT id, requested_at, closed_at, error_message FROM program_backup_requests
                 WHERE machine_id = m.id
                 ORDER BY id DESC LIMIT 1) lr ON true
        WHERE m.company_id = $1 AND m.is_active = true${plantSql('m.id', plantId, companyId)}
        ORDER BY m.machine_serial_no`,
      [companyId, BACKUP_WAIT_MIN, REPORT_WAIT_MIN]
    ),
    liveGateway(companyId)
  ]);
  const machines = rows.map(r => ({
    id: r.id,
    machine_serial_no: r.machine_serial_no,
    // RUNNING, IDLE, ALARM, EMERGENCY or OFFLINE; on_hold: no upload, no backup, nothing offered to the gateway
    status: r.machine_state || null,
    last_seen_at: r.last_seen_at || null,
    on_hold: onHold(r.machine_state),
    // what the gateway is told about this machine (GET /status), as set on the Machines page
    program_path: given(r.program_path),
    machine_ip: r.machine_ip || null,
    controller_type: r.controller_type || null,
    // sent_to_gateway_at: the gateway has it and has not reported yet (report_late: for REPORT_WAIT_MIN or more)
    next: r.next_id ? { id: r.next_id, program_name: r.next_name, size_bytes: r.next_size, created_at: r.next_at,
                        sent_to_gateway_at: r.next_sent_at || null, report_late: !!r.next_report_late } : null,
    waiting: Number(r.waiting || 0),
    last_report: r.report_id
      ? { id: r.report_id, program_name: r.report_name, delivery_status: r.delivery_status,
          delivery_message: r.delivery_message || null, delivered_at: r.delivered_at || null }
      : null,
    last_backup: r.backup_id ? { id: r.backup_id, program_name: r.backup_name, created_at: r.backup_at } : null,
    // the last backup asked for, while the gateway is still offered it
    backup_request: r.request_id && r.request_waiting ? { id: r.request_id, requested_at: r.requested_at } : null,
    backup_failure: backupFailure(r)
  }));
  return { gateway, machines };
};

/** One machine's files, newest first; an upload in line says its place (1 = next). kind: uploads | backups (default: both). */
exports.listFiles = async (req) => {
  const machine = await getMachine(req, req.query.machine_id);
  const { limit, page, offset } = pageOf(req.query, 20);
  const kinds = { uploads: ['NEW'], backups: ['BACKUP', 'FETCHED'] }[String(req.query.kind || '')] || ['NEW', 'BACKUP', 'FETCHED'];
  const where = `f.machine_id = $1 AND f.company_id = $2 AND f.deleted_at IS NULL AND f.kind = ANY($3)`;
  const values = [machine.id, machine.company_id, kinds];
  const [data, count] = await Promise.all([
    pool.query(
      `SELECT ${FILE_COLUMNS}, u.username AS uploaded_by_name, line.position AS queue_position
         FROM program_files f
         LEFT JOIN users u ON u.id = f.uploaded_by
         LEFT JOIN (SELECT f.id, ROW_NUMBER() OVER (ORDER BY f.created_at, f.id) AS position
                      FROM program_files f
                     WHERE f.machine_id = $1 AND ${WAITING}) line ON line.id = f.id
        WHERE ${where}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT $4 OFFSET $5`,
      [...values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM program_files f WHERE ${where}`, values)
  ]);
  const total = count.rows[0].total;
  return {
    data: data.rows.map(f => ({ ...f, queue_position: f.queue_position == null ? null : Number(f.queue_position) })),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
};

/** Upload a program: it joins the end of the machine's line, for its gateway to download. Not while the machine is on hold. */
exports.upload = async (req) => {
  const machine = await readyMachine(req, req.body?.machine_id);
  const file = await saveFile({ machine, kind: 'NEW', staged: req.file, programName: req.body?.program_name, userId: req.user.id });
  auditOf(req, { action: 'PROGRAM_UPLOAD', resource: 'program_file', resource_id: file.id,
                 new_value: { machine: machine.machine_serial_no, program: file.program_name, sha256: file.sha256 } });
  // compared with the row itself: its time passed back from JavaScript would lose the microseconds
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS position
       FROM program_files f JOIN program_files mine ON mine.id = $2
      WHERE f.machine_id = $1 AND ${WAITING} AND (f.created_at, f.id) <= (mine.created_at, mine.id)`,
    [machine.id, file.id]
  );
  return { ...file, queue_position: rows[0]?.position || null };
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
 * Delete a file. An upload still in line leaves it: the gateway is never
 * offered it. (One the gateway is writing right now can still be reported —
 * the report is kept.) The row stays (deleted_at), so the audit names it.
 */
exports.deleteFile = async (req) => {
  const file = await exports.getFile(req);
  await storage.remove(file.folder, file.stored_name);
  await pool.query(`UPDATE program_files SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`, [file.id, req.user.id]);
  auditOf(req, { action: 'PROGRAM_DELETE', resource: 'program_file', resource_id: file.id,
                 old_value: { program: file.program_name, kind: file.kind, machine_id: file.machine_id,
                              waiting: file.kind === 'NEW' && !file.delivery_status } });
};

/**
 * Ask the machine's gateway for a backup. One open request per machine: a
 * second click while one waits returns that one. A request the gateway has
 * not answered within BACKUP_WAIT_MIN is closed, and a new one is made. Not
 * while the machine is on hold.
 */
exports.requestBackup = async (req) => {
  const machine = await readyMachine(req, req.params.machineId);
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

/* ───────────────────────── S&T: the company's gateway token ───────────────────────── */

/** Any company, switched on or not (S&T may set a token up before switching it on), or a 404. */
async function companyFor(value) {
  const id = idOf(value, 'Company not found.', 'COMPANY_NOT_FOUND');
  const { rows } = await pool.query(`SELECT id, company_name, is_active FROM companies WHERE id = $1`, [id]);
  if (!rows.length) throw fail('Company not found.', 'COMPANY_NOT_FOUND', 404);
  return rows[0];
}

const auditFor = (req, company, entry) => audit.log({ user_id: req.user.id, company_id: company.id,
                                                       ip_address: req.ip, user_agent: req.headers?.['user-agent'], ...entry });

/** A company's gateway as S&T sees it: its token, when it last called and from where. */
exports.companyGateway = async (req) => {
  const company = await companyFor(req.params.id);
  return { company_id: company.id, company_name: company.company_name,
           gateway: await liveGateway(company.id, { full: true }), poll_seconds: POLL_SECONDS };
};

/** A new token for the company's gateway; the old one stops at once. Shown in this answer only, never stored. */
exports.createGatewayToken = async (req) => {
  const company = await companyFor(req.params.id);
  const { token, hash, prefix } = deviceToken.generate();
  const client = await pool.connect();
  let gateway;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [company.id]);   // two clicks: one after the other
    await client.query(
      `UPDATE program_gateway_tokens SET revoked_at = NOW(), revoked_by = $2 WHERE company_id = $1 AND revoked_at IS NULL`,
      [company.id, req.user.id]
    );
    ({ rows: [gateway] } = await client.query(
      `INSERT INTO program_gateway_tokens (company_id, token_prefix, token_hash, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, token_prefix, created_at`,
      [company.id, prefix, hash, req.user.id]
    ));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  auditFor(req, company, { action: 'GATEWAY_TOKEN_CREATE', resource: 'program_gateway', resource_id: gateway.id,
                           new_value: { company: company.company_name, token_prefix: prefix } });
  return { token, token_prefix: gateway.token_prefix, created_at: gateway.created_at, company_name: company.company_name };
};

/** Stop the company's gateway token at once (a lost PC, a leaked token). */
exports.revokeGatewayToken = async (req) => {
  const company = await companyFor(req.params.id);
  const { rows } = await pool.query(
    `UPDATE program_gateway_tokens SET revoked_at = NOW(), revoked_by = $2
      WHERE company_id = $1 AND revoked_at IS NULL RETURNING id, token_prefix`,
    [company.id, req.user.id]
  );
  if (!rows.length) throw fail(`${company.company_name} has no gateway token.`, 'NO_TOKEN', 404);
  auditFor(req, company, { action: 'GATEWAY_TOKEN_REVOKE', resource: 'program_gateway', resource_id: rows[0].id,
                           old_value: { company: company.company_name, token_prefix: rows[0].token_prefix } });
};

/* ───────────────────────── the company's gateway ───────────────────────── */

const fileView = f => f && ({ file_id: Number(f.id), program_name: f.program_name, size_bytes: f.size_bytes,
                              sha256: f.sha256, uploaded_at: f.created_at });

const NAME_MAX = 100;
const given = value => {
  const text = value == null ? '' : String(value).trim();
  return text ? text.slice(0, NAME_MAX) : null;
};

/** A machine_id the gateway sent, or null when it sent none; a malformed one is refused. */
function machineIdOf(input = {}) {
  const raw = input.machine_id == null ? '' : String(input.machine_id).trim();
  if (!raw) return null;
  const id = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw fail('machine_id must be a whole number: machine_id from GET /status.', 'BAD_MACHINE_ID');
  return id;
}

/**
 * The machine a gateway call is about: "machine_id" as GET /status lists it
 * (23 Oct 2026, the user: "machine_id, not the name"). Gateways built before
 * then may still send its name ("machine", any case) or address
 * ("machine_ip"), or both; with both, an address MEXA does not know yet (no
 * telemetry) does not stand in the way of the name. A name or address sent
 * with machine_id must be that machine's.
 */
async function machineOf(gateway, input = {}) {
  const id = machineIdOf(input);
  const name = given(input.machine);
  const ip = given(input.machine_ip);
  if (id) {
    const { rows: [m] } = await pool.query(
      `SELECT m.id, m.company_id, m.machine_serial_no, m.is_active, ${MACHINE_IP} AS machine_ip, ${STATE} AS machine_state
         FROM machines m${STATE_JOINS}
        WHERE m.id = $1 AND m.company_id = $2`,
      [id, gateway.company_id]
    );
    if (!m) throw fail(`No machine ${id} in ${gateway.company_name}. Use the machine_id GET /status lists.`, 'MACHINE_NOT_FOUND', 404);
    if (!m.is_active) throw fail(`${m.machine_serial_no} is switched off in MEXA.`, 'MACHINE_INACTIVE', 403);
    if ((name && name.toLowerCase() !== String(m.machine_serial_no).trim().toLowerCase()) || (ip && m.machine_ip && ip !== m.machine_ip)) {
      throw fail(`machine_id ${id} is ${m.machine_serial_no}${m.machine_ip ? ` (${m.machine_ip})` : ''}, not ${name ? `"${name}"` : ip}.`, 'MACHINE_MISMATCH');
    }
    return m;
  }
  if (!name && !ip) {
    throw fail('Say which machine: "machine_id", as GET /status lists it.', 'MACHINE_REQUIRED');
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.company_id, m.machine_serial_no, m.is_active, ${MACHINE_IP} AS machine_ip, ${STATE} AS machine_state
       FROM machines m${STATE_JOINS}
      WHERE m.company_id = $1
        AND ($2::text IS NULL OR lower(btrim(m.machine_serial_no)) = lower($2::text))
        AND ($3::text IS NULL OR ${MACHINE_IP} = $3::text OR ($2::text IS NOT NULL AND ${MACHINE_IP} IS NULL))`,
    [gateway.company_id, name, ip]
  );
  const live = rows.filter(r => r.is_active);
  if (live.length === 1) return live[0];
  if (live.length > 1) {
    throw fail(name && !ip
      ? `${live.length} machines are named "${name}". Send "machine_ip" as well, or give them different names on the Machines page.`
      : `${live.length} machines have the IP ${ip}. Send "machine" (the name) as well.`, 'MACHINE_AMBIGUOUS', 409);
  }
  if (rows.length) throw fail(`${rows[0].machine_serial_no} is switched off in MEXA.`, 'MACHINE_INACTIVE', 403);
  const which = name ? `"${name}"${ip ? ` with IP ${ip}` : ''}` : `with IP ${ip}`;
  throw fail(`No machine ${which} in ${gateway.company_name}. Use the machine_id GET /status lists.`, 'MACHINE_NOT_FOUND', 404);
}

/**
 * What the gateway polls — one call for every machine of the company: who it
 * is (machine_id — what the other calls send —, name, IP, controller and its
 * type (FANUC / MITSUBISHI), its telemetry api_key and its program path, from
 * the Machines page), what it is doing now, the
 * program in front of its line (and how many wait), and an open backup
 * request. A machine on hold (in alarm, emergency stop or disconnected) is
 * offered neither until it is running or idle again. The answer carries each
 * machine's api_key: as private as the token.
 */
exports.gatewayStatus = async (gateway) => {
  const { rows } = await pool.query(
    `SELECT m.id AS machine_id, m.machine_serial_no, ${MACHINE_IP} AS machine_ip, m.controller, m.controller_type, m.api_key, m.program_path,
            ${STATE} AS machine_state,
            q.id AS file_id, q.program_name, q.size_bytes, q.sha256, q.created_at, q.waiting,
            r.id AS request_id, r.requested_at
       FROM machines m${STATE_JOINS}
       LEFT JOIN LATERAL (
              SELECT f.id, f.program_name, f.size_bytes, f.sha256, f.created_at, COUNT(*) OVER () AS waiting
                FROM program_files f
               WHERE f.machine_id = m.id AND ${WAITING}
               ORDER BY f.created_at, f.id LIMIT 1) q ON true
       LEFT JOIN program_backup_requests r
              ON r.machine_id = m.id AND r.closed_at IS NULL AND r.requested_at > NOW() - make_interval(mins => $2)
      WHERE m.company_id = $1 AND m.is_active = true
      ORDER BY m.machine_serial_no, m.id`,
    [gateway.company_id, BACKUP_WAIT_MIN]
  );
  return {
    company: gateway.company_name,
    machines: rows.map(r => {
      const hold = onHold(r.machine_state);
      return {
        machine_id: Number(r.machine_id),
        machine: r.machine_serial_no,
        machine_ip: r.machine_ip || null,
        controller_name: given(r.controller),
        controller_type: r.controller_type || null,
        api_key: r.api_key || null,
        program_path: given(r.program_path),
        machine_status: r.machine_state || null,
        on_hold: hold,
        // on hold: its line waits (programs_waiting still counts it), and so does a backup asked for
        program: !hold && r.file_id ? fileView({ id: r.file_id, program_name: r.program_name, size_bytes: r.size_bytes,
                                                 sha256: r.sha256, created_at: r.created_at }) : null,
        programs_waiting: Number(r.waiting || 0),
        backup_request: !hold && r.request_id ? { id: Number(r.request_id), requested_at: r.requested_at } : null
      };
    }),
    poll_seconds: POLL_SECONDS
  };
};

/** The program in front of a machine's line, to download — marked as with the gateway until it reports. None while the machine is on hold. */
exports.gatewayProgram = async (gateway, query = {}) => {
  const machine = await machineOf(gateway, query);
  if (onHold(machine.machine_state)) throw holdError(machine);
  const program = await nextProgram(machine.id);
  if (!program) throw fail(`Nothing is waiting for ${machine.machine_serial_no}.`, 'NO_PROGRAM', 404);
  await pool.query(
    `UPDATE program_files f SET sent_to_gateway_at = NOW() WHERE f.id = $1 AND ${WAITING}`, [program.id]
  );
  return { machine, program };
};

/** A backup from a machine. It answers the machine's open backup request, and the person who asked is told. */
exports.gatewayBackup = async (gateway, staged, body = {}) => {
  const machine = await machineOf(gateway, body);
  const file = await saveFile({ machine, kind: 'BACKUP', staged, programName: body.program_name, gatewayId: gateway.id });
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
  return { machine_id: Number(machine.id), machine: machine.machine_serial_no, file: fileView(file),
           answered_request: request ? Number(request.id) : null };
};

const REPORT_STATUSES = ['DONE', 'FAILED'];

/**
 * What happened, from the gateway:
 *   { file_id, status: DONE }              the program is on the machine
 *   { file_id, status: FAILED, message }   the machine refused it
 *   { backup_request_id, status: FAILED, message }  the backup could not be read
 * file_id and backup_request_id already say which machine; "machine" (or
 * "machine_ip") may be sent too, and must then be that machine. Either way
 * the program leaves the line, and the answer names the machine's next one.
 * (A backup that worked is answered by POST /backup itself.) Reporting the
 * same thing twice — a retry after a lost answer — changes nothing and
 * notifies no one again.
 */
exports.gatewayReport = async (gateway, body = {}) => {
  const status = String(body.status || '').toUpperCase();
  const message = body.message == null ? null : String(body.message).trim().slice(0, 500) || null;
  if (!REPORT_STATUSES.includes(status)) throw fail('status must be DONE or FAILED.', 'BAD_STATUS');
  if (status === 'FAILED' && !message) throw fail('Say what went wrong in "message".', 'NO_MESSAGE');
  if (body.file_id == null && body.backup_request_id == null) {
    throw fail('Send file_id (a program) or backup_request_id (a backup request).', 'NOTHING_TO_REPORT');
  }
  if (body.file_id == null && status !== 'FAILED') {
    throw fail('A backup that worked is answered by sending the file to POST /backup. Report only FAILED here.', 'BAD_STATUS');
  }
  const named = machineIdOf(body) || given(body.machine) || given(body.machine_ip) ? await machineOf(gateway, body) : null;
  const mismatch = (what, row) => fail(`${what} is for ${row.machine_serial_no}, not ${named.machine_serial_no}.`, 'MACHINE_MISMATCH');

  if (body.file_id != null) {
    const id = idOf(body.file_id, 'file_id must be a number: program.file_id from GET /status (or the X-File-Id header of GET /program).', 'FILE_NOT_FOUND');
    const { rows: [file] } = await pool.query(
      `UPDATE program_files f SET delivery_status = $3, delivery_message = $4, delivered_at = NOW()
         FROM machines m
        WHERE f.id = $1 AND f.company_id = $2 AND f.kind = 'NEW' AND m.id = f.machine_id
          AND ($5::int IS NULL OR f.machine_id = $5::int)
          AND f.delivery_status IS NULL AND f.deleted_at IS NULL
        RETURNING f.id, f.machine_id, f.program_name, f.uploaded_by, m.machine_serial_no`,
      [id, gateway.company_id, status, status === 'DONE' ? null : message, named?.id ?? null]
    );
    let row = file;
    if (!row) {
      ({ rows: [row] } = await pool.query(
        `SELECT f.id, f.kind, f.machine_id, f.delivery_status, f.delivery_message, f.deleted_at, m.machine_serial_no
           FROM program_files f JOIN machines m ON m.id = f.machine_id
          WHERE f.id = $1 AND f.company_id = $2`,
        [id, gateway.company_id]
      ));
      if (!row) {
        throw fail(`No program ${id} in ${gateway.company_name}. Report the file_id GET /status lists under the machine `
          + '(program.file_id), or the X-File-Id header of GET /program.', 'FILE_NOT_FOUND', 404);
      }
      if (row.kind !== 'NEW') {
        throw fail(`${id} is a backup the gateway sent. A backup needs no report: the 201 from POST /backup already finished it. `
          + 'Report DONE or FAILED only for a program from GET /status (program.file_id).', 'BACKUP_NEEDS_NO_REPORT');
      }
      if (named && Number(row.machine_id) !== Number(named.id)) throw mismatch(`Program ${id}`, row);
      if (row.deleted_at) throw fail('This program was removed. Its delivery report cannot be changed.', 'FILE_REMOVED', 409);
      if (row.delivery_status && (row.delivery_status !== status ||
          (row.delivery_message ?? null) !== (status === 'DONE' ? null : message))) {
        throw fail('This program already has a final delivery result. Upload it again to request another transfer.', 'REPORT_CONFLICT', 409);
      }
    }
    const machine = { id: row.machine_id, company_id: gateway.company_id, machine_serial_no: row.machine_serial_no };
    if (file?.uploaded_by) {
      await (status === 'DONE'
        ? tellUser(machine, file.uploaded_by, 'INFO', `Program on ${machine.machine_serial_no}`,
                   `"${file.program_name}" was written to ${machine.machine_serial_no}.`, file.id)
        : tellUser(machine, file.uploaded_by, 'WARNING', `Program not accepted — ${machine.machine_serial_no}`,
                   `${machine.machine_serial_no} could not use "${file.program_name}": ${message}`, file.id));
    }
    // the next one waits while the machine is on hold
    return { file_id: id, machine_id: Number(machine.id), machine: machine.machine_serial_no, status, ...(file ? {} : { unchanged: true }),
             next_program: fileView(await nextProgram(machine.id, pool, { ready: true })) };
  }

  const id = idOf(body.backup_request_id, 'No backup request with this id.', 'REQUEST_NOT_FOUND');
  const { rows: [request] } = await pool.query(
    `UPDATE program_backup_requests r SET closed_at = NOW(), error_message = $3
       FROM machines m
      WHERE r.id = $1 AND r.company_id = $2 AND r.closed_at IS NULL AND m.id = r.machine_id
        AND ($4::int IS NULL OR r.machine_id = $4::int)
      RETURNING r.id, r.machine_id, r.requested_by, m.machine_serial_no`,
    [id, gateway.company_id, message, named?.id ?? null]
  );
  let row = request;
  if (!row) {
    ({ rows: [row] } = await pool.query(
      `SELECT r.id, r.machine_id, m.machine_serial_no
         FROM program_backup_requests r JOIN machines m ON m.id = r.machine_id
        WHERE r.id = $1 AND r.company_id = $2`,
      [id, gateway.company_id]
    ));
    if (!row) throw fail(`No backup request ${id} in ${gateway.company_name}. Use backup_request.id from GET /status.`, 'REQUEST_NOT_FOUND', 404);
    if (named && Number(row.machine_id) !== Number(named.id)) throw mismatch(`Backup request ${id}`, row);
  }
  const machine = { id: row.machine_id, company_id: gateway.company_id, machine_serial_no: row.machine_serial_no };
  if (request?.requested_by) {
    await tellUser(machine, request.requested_by, 'WARNING', `Backup failed — ${machine.machine_serial_no}`,
                   `${machine.machine_serial_no} could not send a backup: ${message}`);
  }
  return { backup_request_id: id, machine_id: Number(machine.id), machine: machine.machine_serial_no, status,
           ...(request ? {} : { unchanged: true }) };
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

exports._internal = { ONLINE_WINDOW_SEC, BACKUP_WAIT_MIN, REPORT_WAIT_MIN, POLL_SECONDS, MACHINE_LIVE_SEC, nextProgram, machineOf, machineIdOf,
                      backupFailure, onHold };
