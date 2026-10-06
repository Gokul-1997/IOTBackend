const erl = require('express-rate-limit');
const rateLimit = erl.rateLimit ?? erl; // v8+ compat
const { ipKeyGenerator } = erl;
const jwt = require('jsonwebtoken');

const { RedisStore } = require('rate-limit-redis');
const redis = require('../redis'); // your ioredis instance

// Create a NEW store per limiter (unique prefix each time)
function makeStore(prefix) {
  return new RedisStore({
    prefix, // defaults to "rl:" if not set
    sendCommand: (command, ...args) => redis.call(command, ...args),
  });
}

const isRedisReady = () => redis.status === 'ready';

/* skip covers Redis being disconnected; passOnStoreError covers it being
   connected but slow — a timed-out store call used to fail every request
   with a 500. Either way requests go through unlimited rather than not at all. */

/* The machines' devices are left out of the per-address count: a factory's
   devices all reach the server from its one public address, and a few
   dozen of them asking for work every 15 seconds would use up the
   allowance of everyone working in that factory. They are counted per
   device instead (deviceLimiter). */
const isDeviceApi = (req) => (req.originalUrl || req.url || '').startsWith('/api/device/');

/*
 * Who is asking: the signed-in user when the request carries a valid token,
 * otherwise the address.
 *
 * Counting by address alone made one factory one client: its people reach
 * the server through one public address, so 1,000 requests per 15 minutes
 * were shared by the whole plant. A few dozen dashboards refreshing every
 * 30 seconds used that up, and everyone in the plant got "Too many
 * requests" until the window passed (measured: 95 % of requests refused
 * with 100 users). Each signed-in user now has an allowance of their own.
 */
function whoIsAsking(req) {
  if (req._rateKey) return req._rateKey;
  let key = `ip:${ipKeyGenerator(req.ip)}`;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try {
      const d = jwt.verify(h.slice(7), process.env.JWT_SECRET);
      if (d && d.user_id) key = `user:${d.user_id}`;
    } catch { /* an invalid token is counted by address */ }
  }
  req._rateKey = key;
  return key;
}

const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // a signed-in user: ~2 requests a second sustained, far above any screen's
  // refresh; anyone else (by address): as before
  limit: (req) => (whoIsAsking(req).startsWith('user:') ? 2000 : 1000),
  store: makeStore('rl:standard:'),
  skip: (req) => req.method === 'OPTIONS' || isDeviceApi(req) || !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: whoIsAsking,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' },
});

/*
 * Sign-in. The limiter that guarded it was mounted on '/auth' while the
 * routes live under '/api/auth', so it never ran: the only brake on password
 * guessing was the per-account lock (5 failures → 15 minutes).
 *
 * Two limits now: per account and address (10 tries in 15 minutes — a person
 * mistyping, not a script), and per address (300 — a whole shift signing in
 * at once from one factory address is fine, spraying thousands of accounts
 * is not).
 */
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  store: makeStore('rl:login:'),
  skip: (req) => req.method !== 'POST' || !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || '').trim().toLowerCase()}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many sign-in attempts for this account. Wait 15 minutes and try again.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  store: makeStore('rl:auth:'),
  skip: (req) => req.method === 'OPTIONS' || !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try later.' },
});

/* Password reset mail and reset tokens: per address. */
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  store: makeStore('rl:pwreset:'),
  skip: (req) => req.method === 'OPTIONS' || !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many password reset requests. Try again in 15 minutes.' },
});

/* Device API: wrong or revoked tokens, counted per address — someone
   trying tokens is cut off long before they could matter (a token is 256
   random bits; this is about load, and about noticing). */
const deviceFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  store: makeStore('rl:devfail:'),
  skip: (req) => !isRedisReady(),
  passOnStoreError: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', code: 'TOO_MANY_FAILURES', message: 'Too many calls with a wrong token. Wait 15 minutes.' },
});

/* Device API, per device once its token is known: polling every 15 s is
   60 calls in 15 minutes; this leaves room for files and retries. */
const deviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  store: makeStore('rl:device:'),
  skip: (req) => !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: (req) => `device:${req.device?.id ?? ipKeyGenerator(req.ip)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', code: 'TOO_MANY_REQUESTS', message: 'Too many calls from this device. Poll every 15 seconds, not faster.' },
});

module.exports = {
  standardLimiter, authLimiter, loginAccountLimiter, passwordLimiter,
  deviceFailLimiter, deviceLimiter, whoIsAsking
};
