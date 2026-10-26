'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const config = require('./config');
const { verifyLease, UUID } = require('./lease');

const error = (code, message, status = 403) => Object.assign(new Error(message), { status, code, expose: true });
const unavailable = () => error('LICENSE_UNAVAILABLE', 'License verification is unavailable. Check the internet connection or contact S&T.', 503);

// One online check per installation, never one per user/request/telemetry packet.
// Leases live only in memory; restarting an offline installation grants no access.
function createRuntime({ env = process.env, db = require('../db'), fetcher = global.fetch,
  now = Date.now, monotonic = () => performance.now(), readFile = file => fs.readFileSync(file, 'utf8'),
  authority = () => require('./authority.service') } = {}) {
  let lease = null, acceptedWall = 0, acceptedMono = 0, online = false, pending = null, interval;
  let settings, lifecycle = 0;
  const bootId = crypto.randomUUID();
  const cache = new Map(), versions = new Map();
  function installation() {
    if (settings) return settings;
    let url;
    try { url = new URL(env.LICENSE_SERVER_URL); } catch { throw error('LICENSE_CONFIGURATION', 'Configure the HTTPS license authority.', 503); }
    const companyId = Number(env.LICENSE_COMPANY_ID), installationId = env.LICENSE_INSTALLATION_ID;
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/licensing/lease')
      || !Number.isSafeInteger(companyId) || companyId < 1 || !UUID.test(installationId || '')
      || !env.LICENSE_ACTIVATION_TOKEN_FILE || !env.LICENSE_VERIFY_KEY_FILE) throw error('LICENSE_CONFIGURATION', 'Installation licensing is not configured correctly.', 503);
    const token = readFile(env.LICENSE_ACTIVATION_TOKEN_FILE).trim(), publicKey = readFile(env.LICENSE_VERIFY_KEY_FILE);
    if (!/^mxl_[A-Za-z0-9_-]{43}$/.test(token)) throw error('LICENSE_CONFIGURATION', 'The installation credential is invalid.', 503);
    settings = { url: url.toString(), companyId, installationId, token, publicKey }; return settings;
  }
  function currentLease() {
    if (!online || !lease) throw unavailable();
    // Wall-clock rollback cannot extend a previously accepted lease.
    const elapsed = Math.max(0, monotonic() - acceptedMono), trustedNow = Math.max(now(), acceptedWall + elapsed);
    if (now() < acceptedWall - 5000 || trustedNow >= lease.exp * 1000 || trustedNow >= lease.license_exp * 1000) {
      online = false; lease = null; throw unavailable();
    }
    return lease;
  }
  async function refresh() {
    if (!config.enabled(env) || config.mode(env) !== 'on_prem') return;
    if (pending) return pending;
    const generation = lifecycle;
    pending = (async () => {
      try {
        const s = installation(), nonce = crypto.randomBytes(32).toString('hex');
        const counts = await db.query('SELECT COUNT(*)::int AS n FROM machines WHERE company_id=$1 AND is_active=TRUE', [s.companyId]);
        const active = Number(counts.rows[0]?.n);
        if (!Number.isSafeInteger(active) || active < 0) throw unavailable();
        const response = await fetcher(s.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
          body: JSON.stringify({ installation_id: s.installationId, boot_id: bootId, nonce, active_machines: active }) });
        if (!response.ok) throw unavailable();
        // Do not consume an unbounded authority/error response into memory.
        const reader = response.body.getReader(); let bytes = 0; const chunks = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 8192) { await reader.cancel(); throw unavailable(); } chunks.push(value); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const verified = verifyLease(body.lease, s.publicKey, { companyId: s.companyId, installationId: s.installationId, bootId, nonce, now: now() });
        if (active > verified.max_machines) throw unavailable();
        if (generation !== lifecycle) return;
        lease = verified; acceptedWall = now(); acceptedMono = monotonic(); online = true;
      } catch { lease = null; online = false; }
    })().finally(() => { pending = null; });
    return pending;
  }
  async function cloud(companyId, queryable) {
    if (queryable) return authority().getCompanyEntitlement(companyId, queryable);
    const existing = cache.get(companyId);
    if (existing && (existing.pending || existing.until > now())) return existing.promise;
    if (cache.size >= 2000) cache.delete(cache.keys().next().value);
    const generation = versions.get(companyId) || 0;
    const entry = { until: now() + 5000, pending: true, promise: null };
    entry.promise = authority().getCompanyEntitlement(companyId).then(value => {
      if ((versions.get(companyId) || 0) !== generation) throw unavailable();
      entry.pending = false;
      entry.until = Math.min(now() + 5000, value ? new Date(value.expires_at).getTime() : Infinity);
      return value;
    }).catch(err => { if (cache.get(companyId) === entry) cache.delete(companyId); throw err; });
    cache.set(companyId, entry); return entry.promise;
  }
  async function assertAccess(user, { queryable } = {}) {
    if (!config.enabled(env)) return null;
    if (config.mode(env) === 'on_prem') {
      const s = installation(), value = currentLease();
      if (Number(user?.company_id) !== s.companyId) throw error('LICENSE_COMPANY', 'This installation is licensed to a different company.');
      return { ...value, expires_at: new Date(value.license_exp * 1000).toISOString() };
    }
    if (user?.is_snt_super || !user?.company_id) return null;
    const value = await cloud(user.company_id, queryable);
    if (value && value.deployment_mode !== 'cloud') throw error('LICENSE_DEPLOYMENT', 'This company uses its licensed on-premise installation.');
    if (value && new Date(value.expires_at).getTime() <= now()) throw error('LICENSE_EXPIRED', 'Your subscription has expired. Contact S&T to renew.');
    return value;
  }
  async function assertMachineSlot(companyId, client) {
    const entitlement = await assertAccess({ company_id: companyId }, { queryable: client });
    if (!entitlement) return;
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM machines WHERE company_id=$1 AND is_active=TRUE', [companyId]);
    if (Number(rows[0].n) >= entitlement.max_machines) throw error('LICENSE_MACHINE_LIMIT', `Your license allows ${entitlement.max_machines} active machines. Contact S&T to increase it.`);
  }
  async function start() {
    if (!config.enabled(env) || config.mode(env) !== 'on_prem') return;
    installation(); // Bad configuration refuses startup; no flag can bypass it.
    await refresh();
    if (!interval) { interval = setInterval(() => { void refresh(); }, 60_000); interval.unref?.(); }
  }
  function stop() { lifecycle++; clearInterval(interval); interval = undefined; online = false; lease = null; settings = undefined; }
  function invalidate(companyId) { cache.delete(companyId); versions.set(companyId, (versions.get(companyId) || 0) + 1); if (versions.size > 4000) versions.delete(versions.keys().next().value); }
  function ready() { if (!config.enabled(env) || config.mode(env) !== 'on_prem') return true; try { currentLease(); return true; } catch { return false; } }
  return { assertAccess, assertMachineSlot, refresh, start, stop, invalidate, ready };
}
let singleton;
const runtime = () => singleton ||= createRuntime();
module.exports = { createRuntime, assertAccess: (...args) => runtime().assertAccess(...args), assertMachineSlot: (...args) => runtime().assertMachineSlot(...args),
  start: () => runtime().start(), stop: () => singleton?.stop(), invalidate: id => singleton?.invalidate(id), ready: () => runtime().ready() };
