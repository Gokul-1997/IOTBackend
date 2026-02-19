require('dotenv').config({ quiet: true });
const app = require('./app');
const redis = require('./redis');

const PORT = process.env.PORT || 8000;

const server = app.listen(PORT, () => {
  console.log(`Server-2 running on port ${PORT}`);
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received: closing server...`);
  server.close(() => {
    console.log('HTTP server closed.');
    // Close DB/Redis connections here if you have them:
    // await pgPool.end();
    redis.quit().catch(() => redis.disconnect());

    process.exit(0);
  });

  // Force exit if stuck
  setTimeout(() => {
    console.error('Force closing after timeout');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Crash handlers (so PM2/systemd restarts cleanly)
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
