/*
 * Dashboards are read far more often than their figures change. Fifty people
 * on a shift opening the Alarm Report for the same week made the database add
 * up the same rows fifty times, each request holding several of the pool's
 * connections while it did — the pool, not the data, is what runs out first
 * when many people use the app at once. Now an answer is worked out once and
 * shared for a short while:
 *
 *   - the same company, dashboard and filters share one answer, kept in
 *     Redis for 30 s while the range includes today (the floor is still
 *     writing to it) and 5 minutes for a range wholly in the past;
 *   - requests for an answer that is being worked out wait for it, rather
 *     than each starting the same queries (in-flight sharing);
 *   - anything a company changes through the API — a ticket, a downtime
 *     reason, a rule, a schedule, a machine — puts every cached answer of
 *     that company out of date at once (a version per company, touch());
 *     what the machines send arrives through the collector, not the API,
 *     and is covered by the 30 s;
 *   - without Redis everything is worked out as before: the cache is never
 *     a reason for a dashboard to fail or to wait.
 *
 * Only answers are kept, never errors. The company is in every key, and the
 * route has checked the caller's permission before the cache is asked.
 */
const crypto = require('crypto');
const redis = require('../redis');

const LIVE_TTL = 30;
const PAST_TTL = 300;
/** Longest a cache read may take before the answer is worked out instead. */
const READ_TIMEOUT_MS = 250;
/** Answers bigger than this are not worth a round trip to Redis. */
const MAX_BYTES = 2 * 1024 * 1024;

const inflight = new Map();

const ready = () => redis.status === 'ready';

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cache read timed out')), ms); })
  ]).finally(() => clearTimeout(timer));
}

/** Plant-time (IST) date today, YYYY-MM-DD. */
function plantToday(now = new Date()) {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * How long an answer for these filters may be shared: a range ending before
 * today is history and changes only when someone edits it (which touches
 * the company); anything else is live.
 */
function ttlFor(query = {}, now = new Date()) {
  const to = String(query.to || query.date || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(to) && to < plantToday(now) ? PAST_TTL : LIVE_TTL;
}

/** The filters as a stable string: the same filters in any order give the same key. */
function fingerprint(params = {}) {
  const pairs = Object.keys(params).sort()
    .filter(k => params[k] !== undefined)
    .map(k => [k, Array.isArray(params[k]) ? params[k].map(String) : String(params[k])]);
  return crypto.createHash('sha1').update(JSON.stringify(pairs)).digest('base64url');
}

const versionKey = companyId => `dash:ver:${companyId}`;

async function versionOf(companyId) {
  if (!ready()) return null;
  try { return (await within(redis.get(versionKey(companyId)), READ_TIMEOUT_MS)) || '0'; }
  catch { return null; }
}

/**
 * The company changed something: each of its cached answers is out of date.
 * Sent before the response that reports the change leaves, so the reload
 * that follows it can never be handed the old answer.
 */
function touch(companyId) {
  if (!companyId || !ready()) return;
  redis.incr(versionKey(companyId)).catch(() => {});
}

/**
 * The JSON text of an answer: shared when another request worked it out in
 * the last `ttl` seconds, or from `compute()` — once, however many ask for
 * it at the same moment.
 */
async function json(name, companyId, params, ttl, compute) {
  // no company, nothing to share it with
  if (companyId === undefined || companyId === null || companyId === '') return JSON.stringify(await compute());

  const version = await versionOf(companyId);
  const key = `dash:${name}:${companyId}:${version ?? 'x'}:${fingerprint(params)}`;

  if (inflight.has(key)) return inflight.get(key);
  if (version !== null) {
    try {
      const hit = await within(redis.get(key), READ_TIMEOUT_MS);
      if (hit) return hit;
    } catch { /* worked out below */ }
  }

  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    const text = JSON.stringify(await compute());
    if (version !== null && text.length <= MAX_BYTES) {
      redis.set(key, text, 'EX', ttl).catch(() => {});
    }
    return text;
  })();
  inflight.set(key, work);
  try { return await work; }
  finally { inflight.delete(key); }
}

/** As json(), for a value used inside a service: the same value on a hit and a miss (as JSON would give it). */
async function remember(name, companyId, params, ttl, compute) {
  return JSON.parse(await json(name, companyId, params, ttl, compute));
}

/*
 * Every request that changes something (not GET), from a signed-in company
 * user, that succeeds: that company's dashboards are out of date. Signing
 * in and out, the machines' own device API and marking notifications read
 * change nothing a dashboard shows.
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UNRELATED = /^\/api\/(auth|device|notifications)(\/|$)/;

function invalidateOnWrite(req, res, next) {
  if (READS.has(req.method) || UNRELATED.test(req.path)) return next();
  const end = res.end;
  res.end = function (...args) {
    if (res.statusCode < 400) touch(req.user?.company_id);
    return end.apply(this, args);
  };
  next();
}

module.exports = { json, remember, touch, ttlFor, fingerprint, plantToday, invalidateOnWrite, LIVE_TTL, PAST_TTL };
