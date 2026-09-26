/*
 * An in-memory stand-in for src/redis.js (an ioredis client) for tests —
 * the commands the app uses: get / set (EX) / setex / del, multi().exec(),
 * publish, and call() for the rate limiters' store.
 *
 * status is never 'ready', so the rate limiters skip, exactly as they do in
 * production when Redis is down.
 */
function createFakeRedis() {
  const store = new Map(); // key -> { value, expiresAt }

  const read = key => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) { store.delete(key); return null; }
    return entry.value;
  };
  const write = (key, value, ttlSeconds) =>
    store.set(key, { value: String(value), expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });

  const redis = {
    status: 'wait',
    async get(key) { return read(key); },
    async set(key, value, ...options) {
      const ex = options.findIndex(o => String(o).toUpperCase() === 'EX');
      write(key, value, ex >= 0 ? Number(options[ex + 1]) : null);
      return 'OK';
    },
    async setex(key, ttlSeconds, value) { write(key, value, Number(ttlSeconds)); return 'OK'; },
    async del(...keys) {
      let removed = 0;
      for (const key of keys.flat()) if (store.delete(key)) removed++;
      return removed;
    },
    async publish() { return 0; },
    // rate-limit-redis loads its script when the limiter is created
    async call(command) { return String(command).toUpperCase() === 'SCRIPT' ? 'fake-sha' : null; },
    multi() {
      const queued = [];
      const chain = {
        set: (...args) => { queued.push(['set', args]); return chain; },
        setex: (...args) => { queued.push(['setex', args]); return chain; },
        del: (...args) => { queued.push(['del', args]); return chain; },
        publish: (...args) => { queued.push(['publish', args]); return chain; },
        async exec() {
          const results = [];
          for (const [name, args] of queued) results.push([null, await redis[name](...args)]);
          return results;
        },
      };
      return chain;
    },
    on() { return redis; },
    once() { return redis; },
    async quit() { return 'OK'; },
    disconnect() {},
  };
  return redis;
}

module.exports = { createFakeRedis };
