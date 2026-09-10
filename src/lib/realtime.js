/*
 * Holds the Socket.IO instance so services can emit without importing
 * server.js (which would be a require cycle: server → app → routes →
 * service → server).
 *
 * server.js calls setIo() once at boot; everything else just emits.
 * Emitting before boot is a no-op rather than a crash, so unit tests and
 * cron jobs that never start the HTTP server still work.
 */
let io = null;

function setIo(instance) {
  io = instance;
}

/** Emit to a single user across all their open tabs/devices. */
function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { setIo, emitToUser };
