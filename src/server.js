require('dotenv').config({ quiet: true });

const http = require('http');
const { Server } = require('socket.io');

const app = require('./app');
const db = require('./db');
const redis = require('./redis'); // ioredis instance
const realtime = require('./lib/realtime');
const socketServer = require('./lib/socket-server');

const PORT = process.env.PORT || 8000;

// Create HTTP server
const httpServer = http.createServer(app);

// Create Socket.IO server
const io = new Server(httpServer, {
  cors: {
    origin: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    credentials: true
  }
});

/* ===============================
   🔐 WebSocket authentication and rooms (lib/socket-server.js)
================================ */
realtime.setIo(io);
socketServer.attach(io, { db });

/* ===============================
   📡 Redis Subscriber (ioredis)
================================ */
const subscriber = redis.duplicate();

subscriber.on('connect', () => {
  console.log('Redis subscriber connected');
});

subscriber.on('error', (err) => {
  console.error('Redis subscriber error:', err);
});

// Subscribe to channel
subscriber.subscribe('machine_updates', (err) => {
  if (err) {
    console.error('Subscribe error:', err);
  } else {
    console.log('Subscribed to machine_updates');
  }
});

// Listen for messages
subscriber.on('message', (channel, message) => {
  // NOTE: do NOT log message here — fires on every machine packet (hot path).
  if (channel === 'machine_updates') socketServer.relay(io, message);
});
/* ===============================
   🚀 Start Server
================================ */
httpServer.listen(PORT, () => {
  console.log(`Server-2 running on port ${PORT}`);
});

/* ===============================
   🛑 Graceful Shutdown
================================ */
const shutdown = async (signal) => {
  console.log(`${signal} received: shutting down...`);

  try {
    require('./cron').stop?.();
    await subscriber.unsubscribe('machine_updates');
    await subscriber.quit();
    await redis.quit();

    io.close();

    httpServer.close(async () => {
      console.log('HTTP server closed.');
      await db.end().catch(() => {});
      process.exit(0);
    });

  } catch (err) {
    console.error('Shutdown error:', err);
    process.exit(1);
  }

  setTimeout(() => {
    console.error('Force shutdown');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

/* After an uncaught exception the process is in an unknown state (a half
   written response, a leaked pool client): log it and exit so pm2 starts a
   clean one, rather than carry on serving from a broken process. */
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception — exiting for a clean restart:', err);
  setTimeout(() => process.exit(1), 500).unref();
});