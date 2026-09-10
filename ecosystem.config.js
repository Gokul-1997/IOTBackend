module.exports = {
  apps: [
    {
      name: "iot-app",
      script: "src/server.js",

      // WARNING: Do NOT use instances > 1 with the current Redis pub/sub design.
      // Each worker creates its own Redis subscriber, so every machine MQTT packet
      // is received and processed by ALL workers simultaneously — multiplying log
      // volume, CPU usage, and Socket.IO emits by the instance count.
      // Use a single instance until a Redis adapter (e.g. socket.io-redis) is added.
      instances: 1,
      exec_mode: "fork",

      // Better restarts / stability
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      // Kill handling (works with your graceful shutdown)
      kill_timeout: 10000,
      listen_timeout: 10000,

      // Logs — rotate at 50 MB, keep last 7 files
      // Run once after deploy: pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 50M
      //   pm2 set pm2-logrotate:retain 7
      //   pm2 set pm2-logrotate:compress true
      merge_logs: true,
      time: true,
      out_file: './logs/out.log',
      error_file: './logs/error.log',

      env_production: {
        NODE_ENV: "production",
        PORT: 8000,
        // CRITICAL: without TZ=Asia/Kolkata the server runs in UTC.
        // All new Date() operations (shiftStart, today, currentTime) produce
        // UTC values, so shiftStartEpoch ends up 5.5 hours late — causing
        // first_count to find no rows → adjusted_parts_count shows raw
        // cumulative counter (e.g. 16331) instead of shift-scoped value.
        TZ: "Asia/Kolkata",
        // REDIS_URL: "redis://localhost:6379/0",
        // DATABASE_URL: "...",
      }
    }
  ]
};
