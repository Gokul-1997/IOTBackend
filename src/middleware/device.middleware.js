/**
 * Authenticates the device at a machine (the Program Transfer API, /api/device/v1).
 *
 * A device sends "Authorization: Bearer mxd_…". Its token is looked up by
 * hash, must not be revoked, and must still belong to an active machine of
 * an active company — a machine switched off or a company S&T disabled stops
 * its device at once. A user's sign-in token is not accepted here, and a
 * device token is not accepted anywhere else (auth.middleware verifies JWTs
 * only), so the two never stand in for each other.
 *
 * Every accepted call is the device's heartbeat: last_seen_at, the address it
 * came from and its agent version are kept, at most every 30 seconds, which
 * is what the Program Transfer screen shows as online / offline.
 */
const db = require('../db');
const deviceToken = require('../programs/device-token');

const SEEN_EVERY_MS = 30_000;

const deny = (res, status, code, message) => res.status(status).json({ status: 'error', code, message });

module.exports = async (req, res, next) => {
  const token = deviceToken.fromRequest(req);
  if (!token) return deny(res, 401, 'TOKEN_MISSING', 'Send the device token as "Authorization: Bearer mxd_…".');

  try {
    const { rows } = await db.query(
      `SELECT d.id, d.company_id, d.machine_id, d.last_seen_at, d.last_seen_ip, d.agent_version,
              m.machine_serial_no, m.ip_address, m.controller_ip, m.program_path, m.is_active AS machine_active, m.company_id AS machine_company_id,
              c.is_active AS company_active
         FROM program_devices d
         JOIN machines  m ON m.id = d.machine_id
         JOIN companies c ON c.id = d.company_id
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
      [deviceToken.hash(token)]
    );
    const d = rows[0];
    // unknown and revoked read the same: nothing to learn from probing
    if (!d) return deny(res, 401, 'TOKEN_INVALID', 'This device token is not valid. Ask an admin for a new one.');
    if (d.company_active === false) return deny(res, 403, 'COMPANY_DISABLED', "The company's access has been turned off.");
    if (!d.machine_active || d.machine_company_id !== d.company_id) {
      return deny(res, 403, 'MACHINE_INACTIVE', `Machine ${d.machine_serial_no} is switched off in the platform.`);
    }

    const ip = req.ip || null;
    const version = String(req.headers['x-agent-version'] || '').slice(0, 50) || null;
    const stale = !d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > SEEN_EVERY_MS;
    if (stale || ip !== d.last_seen_ip || (version && version !== d.agent_version)) {
      await db.query(
        `UPDATE program_devices
            SET last_seen_at = NOW(), last_seen_ip = $2, agent_version = COALESCE($3, agent_version)
          WHERE id = $1`,
        [d.id, ip, version]
      );
    }

    req.device = {
      id: d.id,
      company_id: d.company_id,
      machine: { id: d.machine_id, company_id: d.company_id, machine_serial_no: d.machine_serial_no,
                 ip_address: d.ip_address, controller_ip: d.controller_ip, program_path: d.program_path }
    };
    next();
  } catch (err) {
    console.error('Device auth failed:', err.message);
    deny(res, 500, 'SERVER_ERROR', 'The server could not check the device token. Try again.');
  }
};
