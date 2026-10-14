const { sslOptions, positiveInteger } = require('../../src/config/database');
test('production TLS verifies certificates by default', () => {
  expect(sslOptions({ NODE_ENV: 'production' })).toEqual({ rejectUnauthorized: true });
  expect(sslOptions({ DB_SSL: 'true' })).toEqual({ rejectUnauthorized: true });
});
test('explicit internal non-TLS configuration and development remain supported', () => {
  expect(sslOptions({ NODE_ENV: 'production', DB_SSL: 'false' })).toBe(false);
  expect(sslOptions({ NODE_ENV: 'test' })).toBe(false);
  expect(() => sslOptions({ DB_SSL: 'yes' })).toThrow('DB_SSL');
});
test.each(['NaN', '-1', '0', '1.5', '201'])('refuses invalid pool budget %s', value => {
  expect(() => positiveInteger({ DB_POOL_MAX: value }, 'DB_POOL_MAX', 20, 200)).toThrow('DB_POOL_MAX');
});
