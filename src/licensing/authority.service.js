'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const db = require('../db');
const config = require('./config');
const { issueLease, UUID, NONCE } = require('./lease');

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => `mxl_${crypto.randomBytes(32).toString('base64url')}`;
const safe = row => { if (!row) return row; const { activation_token_hash, ...rest } = row; return rest; };
const idOf = id => { if (!UUID.test(String(id))) throw fail(400, 'LICENSE_INPUT', 'Invalid license ID.'); return id; };
const int = (value, label, max = 100000) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw fail(400, 'LICENSE_INPUT', `${label} must be a whole number from 1 to ${max}.`);
  return value;
};
function text(value, label, max, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw fail(400, 'LICENSE_INPUT', `${label} is invalid (maximum ${max} characters).`);
  return value.trim() || null;
}
function expiry(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw fail(400, 'LICENSE_INPUT', 'Choose a future expiry date with a timezone.');
  return new Date(value).toISOString();
}
async function transaction(work) {
  const client = await db.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') throw fail(409, 'LICENSE_EXISTS', 'This company already has a production license. Renew or update it.'); throw error; }
  finally { client.release(); }
}
async function event(client, action, actor, before, after) {
  await client.query(`INSERT INTO deployment_license_events (license_id,actor_id,action,before_state,after_state,note,payment_reference)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`, [after.id, actor, action, before ? JSON.stringify(safe(before)) : null, JSON.stringify(safe(after)), after.note, after.payment_reference]);
}
function invalidate(companyId) { require('./runtime').invalidate(companyId); }

exports.list = async () => (await db.query(`SELECT l.*,c.company_name FROM deployment_licenses l JOIN companies c ON c.id=l.company_id ORDER BY l.created_at DESC LIMIT 1000`)).rows.map(safe);
exports.create = async (body, actorId) => {
  const company = int(body.company_id, 'Company ID', 2147483647);
  const name = text(body.name, 'Name', 120, true);
  if (!['cloud', 'on_prem'].includes(body.deployment_mode)) throw fail(400, 'LICENSE_INPUT', 'Choose cloud or on_prem.');
  const max = int(body.max_machines ?? 10, 'Machine allowance');
  const expires = expiry(body.expires_at), raw = token();
  const note = text(body.note, 'Note', 1000), payment = text(body.payment_reference, 'Payment reference', 200);
  const license = await transaction(async client => {
    const companyRow = (await client.query('SELECT id FROM companies WHERE id=$1 AND is_active=TRUE FOR UPDATE', [company])).rows[0];
    if (!companyRow) throw fail(404, 'LICENSE_COMPANY', 'Active company not found.');
    const row = (await client.query(`INSERT INTO deployment_licenses
      (id,installation_id,company_id,name,deployment_mode,max_machines,expires_at,activation_token_hash,note,payment_reference,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [crypto.randomUUID(), crypto.randomUUID(), company, name, body.deployment_mode, max, expires, hash(raw), note, payment, actorId])).rows[0];
    await event(client, 'created', actorId, null, row); return safe(row);
  });
  invalidate(company); return { license, activation_token: raw, installation_id: license.installation_id };
};
exports.update = async (id, body, actorId) => {
  idOf(id);
  const allowed = new Set(['max_machines', 'expires_at', 'status', 'note', 'payment_reference']);
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) throw fail(400, 'LICENSE_INPUT', 'Unsupported license change.');
  const changes = {};
  if ('max_machines' in body) changes.max_machines = int(body.max_machines, 'Machine allowance');
  if ('expires_at' in body) changes.expires_at = expiry(body.expires_at);
  if ('status' in body) {
    if (!['active', 'suspended', 'revoked'].includes(body.status)) throw fail(400, 'LICENSE_INPUT', 'Invalid license status.');
    changes.status = body.status;
  }
  for (const [key, max] of [['note', 1000], ['payment_reference', 200]]) if (key in body) changes[key] = text(body[key], key, max);
  const result = await transaction(async client => {
    const before = (await client.query('SELECT * FROM deployment_licenses WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!before) throw fail(404, 'LICENSE_NOT_FOUND', 'License not found.');
    if (before.status === 'revoked' && changes.status && changes.status !== 'revoked') throw fail(409, 'LICENSE_REVOKED', 'A revoked license cannot be reactivated.');
    const fields = Object.keys(changes), params = fields.map(key => changes[key]);
    const after = (await client.query(`UPDATE deployment_licenses SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(',')},
      revision=revision+1,updated_at=NOW(),updated_by=$${params.length + 1} WHERE id=$${params.length + 2} RETURNING *`, [...params, actorId, id])).rows[0];
    await event(client, 'updated', actorId, before, after); return safe(after);
  });
  invalidate(result.company_id); return result;
};
exports.rotateToken = async (id, actorId) => {
  idOf(id); const raw = token();
  const result = await transaction(async client => {
    const before = (await client.query('SELECT * FROM deployment_licenses WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!before) throw fail(404, 'LICENSE_NOT_FOUND', 'License not found.');
    if (before.status === 'revoked') throw fail(409, 'LICENSE_REVOKED', 'A revoked license cannot be rotated.');
    const after = (await client.query(`UPDATE deployment_licenses SET activation_token_hash=$1,active_boot_id=NULL,lease_until=NULL,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=$3 RETURNING *`, [hash(raw), actorId, id])).rows[0];
    await event(client, 'token_rotated', actorId, before, after); return safe(after);
  });
  invalidate(result.company_id); return { activation_token: raw, installation_id: result.installation_id };
};
exports.history = async id => { idOf(id); return (await db.query('SELECT id,actor_id,action,before_state,after_state,note,payment_reference,created_at FROM deployment_license_events WHERE license_id=$1 ORDER BY id DESC LIMIT 200', [id])).rows; };

// Unenrolled legacy companies retain their existing flow. Phase 3 applies only
// after the owner explicitly creates a deployment license for that company.
exports.getCompanyEntitlement = async (companyId, queryable = db) => {
  const row = (await queryable.query(`SELECT l.*,c.is_active AS company_active,cp.is_active AS plan_active,cp.expires_at AS plan_expires_at,
    COALESCE(cp.max_machines,p.max_machines) AS plan_max_machines,
    (SELECT COUNT(*)::int FROM machines m WHERE m.company_id=l.company_id AND m.is_active=TRUE) AS active_machines
    FROM deployment_licenses l JOIN companies c ON c.id=l.company_id
    LEFT JOIN company_plans cp ON cp.company_id=l.company_id LEFT JOIN plans p ON p.id=cp.plan_id
    WHERE l.company_id=$1`, [companyId])).rows[0];
  if (!row) return null;
  if (row.company_active === false) throw fail(403, 'LICENSE_COMPANY_DISABLED', 'Company access is disabled. Contact S&T.');
  if (row.status !== 'active') throw fail(403, 'LICENSE_BLOCKED', 'This license is suspended or revoked. Contact S&T.');
  if (new Date(row.expires_at).getTime() <= Date.now() || !row.plan_active || (row.plan_expires_at && new Date(row.plan_expires_at).getTime() <= Date.now())) throw fail(403, 'LICENSE_EXPIRED', 'Your subscription has expired or has no active plan. Contact S&T to renew.');
  const planMax = Number(row.plan_max_machines);
  if (!Number.isSafeInteger(planMax) || planMax < 1) throw fail(403, 'LICENSE_PLAN_REQUIRED', 'An active plan with a machine allowance is required.');
  const max = Math.min(Number(row.max_machines), planMax);
  if (Number(row.active_machines) > max) throw fail(403, 'LICENSE_MACHINE_LIMIT', 'The active machine count exceeds the licensed allowance. Contact S&T.');
  const expires = Math.min(new Date(row.expires_at).getTime(), row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : Infinity);
  return { license_id: row.id, company_id: row.company_id, installation_id: row.installation_id, deployment_mode: row.deployment_mode,
    max_machines: max, expires_at: new Date(expires).toISOString(), status: row.status, revision: Number(row.revision) };
};
exports.lease = async (body, raw) => {
  if (typeof raw !== 'string' || !/^mxl_[A-Za-z0-9_-]{43}$/.test(raw)) throw fail(401, 'LICENSE_TOKEN', 'Invalid installation credential.');
  if (!UUID.test(String(body.installation_id)) || !UUID.test(String(body.boot_id)) || !NONCE.test(String(body.nonce)) || !Number.isSafeInteger(body.active_machines) || body.active_machines < 0 || body.active_machines > 100000) throw fail(400, 'LICENSE_INPUT', 'Invalid installation check.');
  return transaction(async client => {
  const row = (await client.query('SELECT company_id,installation_id,active_boot_id,lease_until FROM deployment_licenses WHERE activation_token_hash=$1 FOR UPDATE', [hash(raw)])).rows[0];
  if (!row || row.installation_id !== body.installation_id) throw fail(401, 'LICENSE_TOKEN', 'Invalid installation credential.');
  if (row.active_boot_id && row.active_boot_id !== body.boot_id && new Date(row.lease_until).getTime() > Date.now()) throw fail(409, 'LICENSE_INSTANCE_ACTIVE', 'This license is already active on another API instance. Stop it and wait for its lease to expire, or ask S&T to rotate the credential.');
  const entitlement = await exports.getCompanyEntitlement(row.company_id, client);
  if (!entitlement || entitlement.deployment_mode !== 'on_prem' || body.active_machines > entitlement.max_machines) throw fail(403, 'LICENSE_MACHINE_LIMIT', 'This installation is not entitled to the requested machine allowance.');
  const now = Math.floor(Date.now() / 1000), end = Math.floor(new Date(entitlement.expires_at).getTime() / 1000);
  const keyFile = config.signingKeyFile();
  if (!keyFile) throw fail(503, 'LICENSE_AUTHORITY_UNAVAILABLE', 'License authority is unavailable.');
  const keyStat = fs.statSync(keyFile);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) throw fail(503, 'LICENSE_AUTHORITY_UNAVAILABLE', 'License authority is unavailable.');
  const signed = issueLease({ v: 1, deployment_mode: 'on_prem', company_id: row.company_id, installation_id: row.installation_id, boot_id: body.boot_id,
    license_id: entitlement.license_id, max_machines: entitlement.max_machines, revision: entitlement.revision,
    iat: now, exp: Math.min(now + 120, end), license_exp: end, nonce: body.nonce }, fs.readFileSync(keyFile));
  await client.query('UPDATE deployment_licenses SET last_seen_at=NOW(),last_reported_machines=$2,active_boot_id=$3,lease_until=$4 WHERE id=$1', [entitlement.license_id, body.active_machines, body.boot_id, new Date(Math.min(now + 120, end) * 1000)]);
  return { lease: signed };
  });
};
exports.hashToken = hash;
