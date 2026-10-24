/** Reuse concurrent probes and keep at most one outstanding call per dependency. */
const oneAtATime = (read, timeoutMs) => {
  let pending;
  return () => {
    if (!pending) {
      const work = Promise.resolve().then(read);
      // Keep one deadline race per actual operation. Repeated probes of a
      // permanently hung dependency must not append promise handlers forever.
      const bounded = within(work, timeoutMs);
      pending = bounded;
      const clear = () => { if (pending === bounded) pending = null; };
      work.then(clear, clear);
    }
    return pending;
  };
};

function within(work, milliseconds) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Dependency probe timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function createReadiness({ db, redis, timeoutMs = 2000, cacheMs = 1000, now = Date.now }) {
  const database = oneAtATime(() => db.query('SELECT 1'), timeoutMs);
  const cache = oneAtATime(() => redis.ping(), timeoutMs);
  let pending, result, expires = 0;
  return () => {
    if (pending) return pending;
    if (result && now() < expires) return Promise.resolve(result);
    const work = Promise.all([
      database().then(() => true, () => false),
      cache().then(value => value === 'PONG', () => false)
    ]).then(([db, redis]) => {
      result = { ok: db && redis, db, redis };
      expires = now() + cacheMs;
      return result;
    }).finally(() => { if (pending === work) pending = null; });
    pending = work;
    return work;
  };
}

module.exports = { createReadiness };
