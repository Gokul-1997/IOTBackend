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

const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  store: makeStore('rl:standard:'),
  skip: (req) => req.method === 'OPTIONS' || !isRedisReady(),
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
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try later.' },
});

module.exports = { standardLimiter, authLimiter };
