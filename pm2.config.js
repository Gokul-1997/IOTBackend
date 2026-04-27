/*
 * PM2 ecosystem for the API server.
 * Cluster mode → uses all CPUs, zero-downtime via `pm2 reload api`.
 *
 * Use:
 *   pm2 start pm2.config.js --env production
 *   pm2 reload api --update-env
 */

module.exports = {
  apps: [
    {
      name:        'api',
      script:      'src/server.js',
      instances:   'max',
      exec_mode:   'cluster',
      max_memory_restart: '600M',
      kill_timeout: 5000,
      wait_ready:  false,
      listen_timeout: 10_000,
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
