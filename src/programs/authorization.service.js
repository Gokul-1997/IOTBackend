/*
 * Supervisor authorisation for CNC program transfers.
 *
 * Sending a program to a controller can crash a spindle or scrap a part,
 * so the machine's assigned supervisor has to sign the transfer off with
 * a one-time code before any bytes move. The agreement calls for
 * "OTP-based supervisor authorization, with complete OTP and
 * file-transfer audit logging".
 *
 * Only UPLOAD (server -> CNC) is gated. Fetching a program off a
 * controller and deleting one from the server library are not: neither
 * touches a running machine.
 */

const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('../utils/nodemailer');
const { generateTransferAuthTemplate } = require('../utils/nodemailer/emailTemplates/generateTransferAuthTemplate');

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

/*
 * A batch calls uploadOne once per program, and the frontend answers a
 * FILE_EXISTS result by re-sending the whole batch with overwrite=true —
 * so one code legitimately covers many verifications. The cap only has
 * to bound abuse inside the 10-minute window, not fit a batch exactly.
 */
const MAX_USES = 100;

/** Same SHA-256 treatment password reset tokens get: the code is never stored raw. */
function hashCode(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * 6 digits, uniform, from a CSPRNG. randomInt avoids the modulo bias
 * that `randomBytes % 1000000` would introduce.
 */
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** r***@stm.com — enough for the requester to know who to ask, not enough to harvest. */
function maskEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Errors the UI branches on, matching the fileExistsError convention. */
function authError(message, code, status = 403) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/**
 * Delivery adapter. Email is the only channel with working
 * infrastructure today; SMS needs a gateway (vendor, credentials, cost)
 * that does not exist in this codebase yet. Keeping the branch here
 * means adding SMS later is one arm of a switch, not a refactor.
 */
async function sendAuthCode({ channel, supervisor, code, machineSerial, programNames, requesterName }) {
  if (channel === 'SMS') {
    throw authError(
      'SMS delivery is not configured on this server. Contact your administrator.',
      'CHANNEL_UNAVAILABLE',
      501
    );
  }

  if (!supervisor.email) {
    throw authError(
      `${supervisor.username} has no email address on file, so an authorisation code cannot be sent. An administrator must add one.`,
      'SUPERVISOR_UNREACHABLE'
    );
  }

  await sendEmail({
    to: supervisor.email,
    subject: `Authorisation code for program transfer to ${machineSerial}`,
    html: generateTransferAuthTemplate({
      supervisorName: supervisor.username,
      requesterName,
      machineSerial,
      programNames,
      code,
      expiresInMinutes: CODE_TTL_MINUTES
    }),
    text: `Authorisation code: ${code}. Machine ${machineSerial}. Expires in ${CODE_TTL_MINUTES} minutes.`
  });

  return maskEmail(supervisor.email);
}

/* ─────────────────────────────────────────────────────────────
   Supervisor assignment
   ───────────────────────────────────────────────────────────── */

/** Active supervisors for one machine, company-scoped. */
exports.listSupervisors = async (machineId, companyId) => {
  const { rows } = await db.query(
    `SELECT ms.user_id AS id, u.username, u.email
     FROM machine_supervisors ms
     JOIN users u ON u.id = ms.user_id
     WHERE ms.machine_id = $1
       AND ms.company_id = $2
       AND ms.is_active = true
       AND u.is_active = true
     ORDER BY u.username`,
    [machineId, companyId]
  );
  return rows;
};

/** Machines one user supervises — powers the checkbox list on the user form. */
exports.listSupervisedMachines = async (userId, companyId) => {
  const { rows } = await db.query(
    `SELECT machine_id FROM machine_supervisors
     WHERE user_id = $1 AND company_id = $2 AND is_active = true`,
    [userId, companyId]
  );
  return rows.map(r => r.machine_id);
};

/**
 * Replace a user's supervised machines.
 *
 * Soft-deactivates rather than deleting so a past authorisation still
 * resolves to a real assignment when the audit log is read back.
 * Scoped by company_id on every statement: machine ids arrive from the
 * client and must never reach another tenant's rows.
 */
exports.setSupervisedMachines = async (userId, companyId, machineIds, assignedBy) => {
  // Number(null) is 0, which Number.isInteger happily accepts — so the
  // positive check is what actually keeps junk ids out of the loop.
  const ids = Array.isArray(machineIds)
    ? machineIds.map(Number).filter(n => Number.isInteger(n) && n > 0)
    : [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE machine_supervisors SET is_active = false
       WHERE user_id = $1 AND company_id = $2`,
      [userId, companyId]
    );

    for (const machineId of ids) {
      await client.query(
        `INSERT INTO machine_supervisors (company_id, machine_id, user_id, assigned_by, is_active)
         SELECT $1, m.id, $3, $4, true
         FROM machines m
         WHERE m.id = $2 AND m.company_id = $1
         ON CONFLICT (machine_id, user_id)
         DO UPDATE SET is_active = true, assigned_by = $4`,
        [companyId, machineId, userId, assignedBy || null]
      );
    }

    await client.query('COMMIT');
    return ids;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/* ─────────────────────────────────────────────────────────────
   Requesting a code
   ───────────────────────────────────────────────────────────── */

/**
 * Issue a one-time code to the supervisor who will authorise this
 * transfer. Returns the masked destination so the requester knows who
 * to ask — never the code itself.
 */
exports.requestAuthorization = async ({ machine_id, program_ids = [], supervisor_id, channel = 'EMAIL', user }) => {
  if (!machine_id) throw authError('machine_id is required', 'BAD_REQUEST', 400);

  const { rows: machineRows } = await db.query(
    `SELECT id, machine_serial_no FROM machines
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [machine_id, user.company_id]
  );
  if (machineRows.length === 0) throw authError('Machine not found or access denied', 'NOT_FOUND', 404);
  const machine = machineRows[0];

  const supervisors = await exports.listSupervisors(machine.id, user.company_id);
  if (supervisors.length === 0) {
    throw authError(
      `No supervisor is assigned to ${machine.machine_serial_no}. An administrator must assign one before programs can be transferred to it.`,
      'NO_SUPERVISOR_ASSIGNED'
    );
  }

  // One named approver per code keeps the audit trail unambiguous. With
  // a single supervisor there is nothing to choose, so don't ask.
  let supervisor;
  if (supervisor_id) {
    supervisor = supervisors.find(s => s.id === Number(supervisor_id));
    if (!supervisor) {
      throw authError('That user does not supervise this machine', 'INVALID_SUPERVISOR', 400);
    }
  } else if (supervisors.length === 1) {
    supervisor = supervisors[0];
  } else {
    const e = authError('Choose which supervisor should authorise this transfer', 'SUPERVISOR_REQUIRED', 400);
    e.supervisors = supervisors.map(s => ({ id: s.id, username: s.username }));
    throw e;
  }

  const programNames = await programNamesFor(program_ids, user.company_id);

  const code = generateCode();
  const { rows: [auth] } = await db.query(
    `INSERT INTO transfer_authorizations
       (company_id, machine_id, requested_by, supervisor_id, code_hash, channel,
        program_ids, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' minutes')::interval)
     RETURNING id, expires_at`,
    [user.company_id, machine.id, user.id, supervisor.id, hashCode(code), channel,
     program_ids.map(Number), String(CODE_TTL_MINUTES)]
  );

  let sentTo;
  try {
    sentTo = await sendAuthCode({
      channel,
      supervisor,
      code,
      machineSerial: machine.machine_serial_no,
      programNames,
      requesterName: user.username
    });
  } catch (err) {
    // A code nobody can read is worse than no code: retire it rather
    // than leaving a valid hash sitting in the table.
    await db.query(
      `UPDATE transfer_authorizations SET status = 'EXPIRED' WHERE id = $1`,
      [auth.id]
    );
    if (err.code) throw err;
    throw authError(
      `Could not send the authorisation code: ${err.message}`,
      'DELIVERY_FAILED',
      502
    );
  }

  await db.query(
    `UPDATE transfer_authorizations SET sent_to = $2 WHERE id = $1`,
    [auth.id, sentTo]
  );

  return {
    authorization_id: auth.id,
    expires_at: auth.expires_at,
    machine_serial: machine.machine_serial_no,
    supervisor: { id: supervisor.id, username: supervisor.username, sent_to: sentTo },
    channel
  };
};

/** Program names for the email body. Best-effort — never block a code on this. */
async function programNamesFor(programIds, companyId) {
  if (!Array.isArray(programIds) || programIds.length === 0) return [];
  try {
    const { rows } = await db.query(
      `SELECT name FROM programs WHERE id = ANY($1::bigint[]) AND company_id = $2`,
      [programIds.map(Number), companyId]
    );
    return rows.map(r => r.name);
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────
   Verifying a code
   ───────────────────────────────────────────────────────────── */

/**
 * Check a code against one authorisation and consume a use.
 *
 * Locked under FOR UPDATE so concurrent guesses can't race past the
 * attempt counter. Attempt limiting lives in the row rather than in
 * Redis on purpose: both express-rate-limit limiters skip() when Redis
 * is unavailable, which would silently disable brute-force protection
 * on a safety control.
 */
exports.verifyAuthorization = async ({ authorization_id, code, machine_id, company_id }) => {
  if (!authorization_id || !code) {
    throw authError('An authorisation code is required', 'APPROVAL_REQUIRED');
  }

  const client = await db.connect();
  // A rejection still has to persist its side effects — the attempt
  // counter and the expiry stamp are the whole point of the guard — so
  // business rejections are held until after COMMIT rather than thrown
  // into the ROLLBACK. Only genuine DB failures roll back.
  let deferred = null;
  let verified = null;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, company_id, machine_id, supervisor_id, code_hash, attempts, uses,
              status, expires_at
       FROM transfer_authorizations
       WHERE id = $1
       FOR UPDATE`,
      [authorization_id]
    );

    const auth = rows[0];

    // Tenant isolation first, and deliberately indistinguishable from a
    // bad id — never confirm that another company's row exists.
    if (!auth || auth.company_id !== company_id) {
      deferred = authError('Authorisation not found', 'INVALID_CODE');

    // A code issued for one machine must never authorise another.
    } else if (Number(auth.machine_id) !== Number(machine_id)) {
      deferred = authError(
        'That authorisation code was issued for a different machine.',
        'WRONG_MACHINE'
      );

    } else if (auth.status === 'LOCKED') {
      deferred = authError(
        'Too many incorrect codes. Request a new authorisation code.',
        'CODE_LOCKED'
      );

    } else if (auth.status === 'EXPIRED' || new Date(auth.expires_at) <= new Date()) {
      await client.query(
        `UPDATE transfer_authorizations SET status = 'EXPIRED' WHERE id = $1`,
        [auth.id]
      );
      deferred = authError(
        'That authorisation code has expired. Request a new one.',
        'CODE_EXPIRED'
      );

    } else if (auth.uses >= MAX_USES) {
      deferred = authError(
        'That authorisation code has been used too many times. Request a new one.',
        'CODE_EXHAUSTED'
      );

    } else {
      // timingSafeEqual over the hex digests: both are fixed 64-char
      // strings, so there is no length mismatch to guard against.
      const supplied = Buffer.from(hashCode(code));
      const stored = Buffer.from(auth.code_hash);
      const ok = supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);

      if (!ok) {
        const attempts = auth.attempts + 1;
        const locked = attempts >= MAX_ATTEMPTS;
        const left = MAX_ATTEMPTS - attempts;
        await client.query(
          `UPDATE transfer_authorizations
           SET attempts = $2, status = CASE WHEN $3 THEN 'LOCKED' ELSE status END
           WHERE id = $1`,
          [auth.id, attempts, locked]
        );
        deferred = authError(
          locked
            ? 'Too many incorrect codes. Request a new authorisation code.'
            : `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} remaining.`,
          locked ? 'CODE_LOCKED' : 'INVALID_CODE'
        );
      } else {
        const { rows: [updated] } = await client.query(
          `UPDATE transfer_authorizations
           SET status = 'VERIFIED',
               uses = uses + 1,
               verified_at = COALESCE(verified_at, NOW())
           WHERE id = $1
           RETURNING id, supervisor_id, verified_at`,
          [auth.id]
        );
        verified = updated;
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  if (deferred) throw deferred;
  return verified;
};

/**
 * The guard. Called from uploadOne — the single point every machine
 * write funnels through, so no route can reach a controller around it.
 *
 * Returns the verified authorisation so the caller can stamp
 * authorized_by / authorized_at onto the transfer record.
 */
exports.assertAuthorized = async (machine, user, { authorization_id, code } = {}) => {
  if (!authorization_id || !code) {
    // Distinguish "nobody can approve this" from "go get approval":
    // the first needs an administrator, the second needs a supervisor.
    const supervisors = await exports.listSupervisors(machine.id, user.company_id);
    if (supervisors.length === 0) {
      throw authError(
        `No supervisor is assigned to ${machine.machine_serial_no}. An administrator must assign one before programs can be transferred to it.`,
        'NO_SUPERVISOR_ASSIGNED'
      );
    }
    throw authError(
      `Sending to ${machine.machine_serial_no} needs supervisor authorisation.`,
      'APPROVAL_REQUIRED'
    );
  }

  return exports.verifyAuthorization({
    authorization_id,
    code,
    machine_id: machine.id,
    company_id: user.company_id
  });
};

exports.CODE_TTL_MINUTES = CODE_TTL_MINUTES;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
exports.MAX_USES = MAX_USES;
exports._internal = { hashCode, generateCode, maskEmail };
