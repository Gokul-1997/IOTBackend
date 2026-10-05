const erl = require('express-rate-limit');
const rateLimit = erl.rateLimit ?? erl; // v8+ compat
const { ipKeyGenerator } = erl;

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

const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  store: makeStore('rl:standard:'),
  skip: (req) => req.method === 'OPTIONS' || isDeviceApi(req) || !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip), // IPv6-safe fallback
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  store: makeStore('rl:auth:'),
  skip: (req) => req.method === 'OPTIONS' || !isRedisReady(),
  passOnStoreError: true,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try later.' },
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

module.exports = { standardLimiter, authLimiter, deviceFailLimiter, deviceLimiter };
