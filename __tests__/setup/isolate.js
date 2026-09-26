/*
 * Runs before every test file (package.json jest.setupFiles).
 *
 * Tests must never reach the services named in .env: that .env is
 * production. They did — any test that loaded the auth or access middleware
 * got the real Redis client, and those middlewares WRITE to Redis (a user's
 * cached row, a company's granted pages, 60 s each), so a test run could
 * hand a real user or company the fixture's fake grants for a minute. One
 * test also opened a real database connection through plan.service → db.js.
 *
 * 1. Point every connection setting at nothing. dotenv never overwrites a
 *    variable that is already set, so these win over .env wherever a module
 *    later calls dotenv.config().
 * 2. Replace src/redis and src/db with in-memory stand-ins. A test file that
 *    mocks either one itself still gets its own mock — its jest.mock runs
 *    after this one and replaces it.
 * 3. Keep the run quiet. Tests drive error paths on purpose and the code logs
 *    them; with 1,300+ tests that buried the one line that matters (PASS or
 *    FAIL). TEST_LOGS=1 npm test shows the logs again.
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  DOTENV_CONFIG_QUIET: 'true',
  POSTGRESQL_HOST: '127.0.0.1',
  POSTGRESQL_PORT: '1',
  POSTGRESQL_USER: 'test',
  POSTGRESQL_PASSWORD: 'test',
  POSTGRESQL_DATABASE: 'test',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_SECRET: 'test-secret',
  EMAIL_USER: '',
  EMAIL_PASS: '',
  AWS_ACCESS_KEY: '',
  AWS_SECRET_KEY: '',
  AWS_S3_BUCKET: '',
  RECAPTCHA_SECRET_KEY: '',
});

jest.mock('../../src/redis', () => require('./fake-redis').createFakeRedis());

jest.mock('../../src/db', () => {
  const empty = async () => ({ rows: [], rowCount: 0 });
  const client = { query: jest.fn(empty), release: jest.fn() };
  return {
    query: jest.fn(empty),
    connect: jest.fn(async () => client),
    on: jest.fn(),
    end: jest.fn(async () => {}),
  };
});

if (!process.env.TEST_LOGS) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};
}
