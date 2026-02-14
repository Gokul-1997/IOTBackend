// src/config/redis.js
const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL; // load dotenv in server.js only

const redis = new Redis(redisUrl, {
  // Fast failure (good for HTTP APIs)
  maxRetriesPerRequest: 2,
  commandTimeout: 2000,

  // Connection stability
  connectTimeout: 10000,
  keepAlive: 10000,
  enableReadyCheck: true,

  // Optional performance
  enableAutoPipelining: true,

  // Controlled reconnect backoff
  retryStrategy: (times) => {
    // times = number of reconnect attempts
    // 200ms -> 2s max
    return Math.min(times * 200, 2000);
  },

  // Reconnect for some Redis errors (optional)
  reconnectOnError: (err) => {
    const msg = err?.message || '';
    // Examples: READONLY in replicas, connection resets, etc.
    return msg.includes('READONLY') || msg.includes('ECONNRESET');
  },
});

redis.on('connect', () => {
  console.log('Redis connected API SERVER');
});

redis.on('ready', () => {
  console.log('Redis ready');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('close', () => {
  console.warn('Redis connection closed');
});

module.exports = redis;
