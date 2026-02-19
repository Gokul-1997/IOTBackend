module.exports = {
  apps: [
    {
      name: "iot-app",
      script: "src/server.js",        
      instances: "max",
      exec_mode: "cluster",

      // Better restarts / stability
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      // Kill handling (works with your graceful shutdown)
      kill_timeout: 10000,
      listen_timeout: 10000,

      // Logs
      merge_logs: true,
      time: true,

      env_production: {
        NODE_ENV: "production",
        PORT: 8000,
        // REDIS_URL: "redis://localhost:6379/0",
        // DATABASE_URL: "...",
      }
    }
  ]
};
