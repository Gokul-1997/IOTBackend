const Redis = require('ioredis');
require('dotenv').config();

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});

redis.on('connect', () => {
  console.log('Redis connected (Server-2)');
});

redis.on('error', err => {
  console.error('Redis error:', err);
});

module.exports = redis;
