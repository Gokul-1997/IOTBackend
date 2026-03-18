require('dotenv').config({ quiet: true });

const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = require('./app');
const redis = require('./redis'); // ioredis instance

const PORT = process.env.PORT || 8000;

// Create HTTP server
const httpServer = http.createServer(app);

// Create Socket.IO server
const io = new Server(httpServer, {
  cors: {
    origin: (process.env.CORS_ORIGINS || '').split(','),
    credentials: true
  }
});

/* ===============================
   🔐 WebSocket Authentication
================================ */
io.use((socket, next) => {
  try {
    let token = socket.handshake.auth?.token;

    if (!token) {
      console.log("❌ No token received");
      return next(new Error('Unauthorized'));
    }

    /* ✅ REMOVE "Bearer " if exists */
    if (token.startsWith('Bearer ')) {
      token = token.slice(7);
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    socket.user = decoded;

    next();

  } catch (err) {
    console.log("❌ JWT VERIFY ERROR:", err.message);
    next(new Error('Unauthorized'));
  }
});

/* ===============================
   🔄 Socket Connection
================================ */
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinPlant', (plantId) => {
    socket.join(`plant:${plantId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

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
  if (channel === 'machine_updates') {
    console.log('🔥 REDIS RECEIVED:', message);

    const data = JSON.parse(message);

    console.log('🔥 EMITTING TO ROOM:', `plant:${data.plant_id}`);

    io.to(`plant:${data.plant_id}`).emit('machineUpdate', data);
  }
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
    await subscriber.unsubscribe('machine_updates');
    await subscriber.quit();
    await redis.quit();

    io.close();

    httpServer.close(() => {
      console.log('HTTP server closed.');
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

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});