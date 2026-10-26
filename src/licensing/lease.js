'use strict';
const crypto = require('node:crypto');

const MAX_TTL_SECONDS = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{64}$/;
const fail = () => Object.assign(new Error('The license lease is invalid or expired.'), { status: 403, code: 'LICENSE_INVALID_LEASE' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const epoch = value => Number.isSafeInteger(value) && value > 0;

function validate(claims, now) {
  const seconds = Math.floor(now / 1000);
  if (!Number.isFinite(now) || !claims || Array.isArray(claims) || claims.v !== 1 || claims.deployment_mode !== 'on_prem'
    || !positive(claims.company_id) || !UUID.test(claims.license_id) || !UUID.test(claims.installation_id) || !UUID.test(claims.boot_id)
    || !positive(claims.max_machines) || claims.max_machines > 100000 || !positive(claims.revision)
    || typeof claims.nonce !== 'string' || !NONCE.test(claims.nonce)
    || !epoch(claims.iat) || !epoch(claims.exp) || !epoch(claims.license_exp)
    || claims.iat > seconds + 5 || claims.exp <= seconds || claims.license_exp <= seconds
    || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TTL_SECONDS || claims.exp > claims.license_exp) throw fail();
  return claims;
}

function keyOf(value, type) {
  const key = type === 'private' ? crypto.createPrivateKey(value) : crypto.createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw fail();
  return key;
}

function issueLease(claims, privateKey) {
  validate(claims, Date.now());
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'MEXA-LICENSE', v: 1 })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${crypto.sign(null, Buffer.from(data), keyOf(privateKey, 'private')).toString('base64url')}`;
}

function verifyLease(token, publicKey, { companyId, installationId, bootId, nonce, now = Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 4096 || !positive(companyId) || !UUID.test(installationId) || !UUID.test(bootId)
      || typeof nonce !== 'string' || !NONCE.test(nonce)) throw fail();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw fail();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'EdDSA' || header.typ !== 'MEXA-LICENSE' || header.v !== 1) throw fail();
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.length !== 64 || !crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), keyOf(publicKey, 'public'), signature)) throw fail();
    const claims = validate(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), now);
    if (claims.company_id !== companyId || claims.installation_id !== installationId || claims.boot_id !== bootId || claims.nonce !== nonce) throw fail();
    return claims;
  } catch { throw fail(); }
}

module.exports = { issueLease, verifyLease, MAX_TTL_SECONDS, UUID, NONCE };
