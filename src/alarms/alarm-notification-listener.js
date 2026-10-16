const db = require('../db');
const drain = require('../cron/alarmNotifications.job');

/** NOTIFY is a wake-up hint. Every delivery is recovered from the durable
 * outbox, including notifications missed while this connection is down. */
function startAlarmNotifications({ pool = db, run = drain, enabled = process.env.CRON_ENABLED !== 'false' && process.env.NODE_ENV !== 'test' } = {}) {
  if (!enabled) return async () => {};
  let stopped = false, client, reconnectTimer, drainTimer;
  let connecting = false, running = false, pending = false, backoff = 1000;
  let currentRun;
  function scheduleDrain() {
    pending = true;
    if (stopped || running || drainTimer) return;
    drainTimer = setTimeout(async () => {
      drainTimer = undefined;
      if (stopped) return;
      running = true; pending = false;
      try {
        currentRun = Promise.resolve().then(run);
        const result = await currentRun;
        pending ||= !!result?.hasMore;
      } catch (error) { console.error('Alarm event dispatch failed:', error.message); }
      finally { currentRun = undefined; running = false; if (pending && !stopped) scheduleDrain(); }
    }, 20);
    drainTimer.unref?.();
  }
  function disconnected(error) {
    if (client) {
      const lost = client; client = undefined;
      lost.removeListener('notification', onNotification);
      lost.removeListener('error', disconnected);
      lost.removeListener('end', disconnected);
      lost.release(true);
    }
    if (stopped || reconnectTimer) return;
    if (error) console.error('Alarm event listener disconnected:', error.message);
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(backoff * 2, 30000);
  }
  function onNotification(event) { if (event.channel === 'cnc_alarm_events') scheduleDrain(); }
  async function connect() {
    if (stopped || connecting || client) return;
    connecting = true;
    try {
      const connected = await pool.connect();
      if (stopped) { connected.release(); return; }
      client = connected;
      client.on('notification', onNotification);
      client.on('error', disconnected);
      client.on('end', disconnected);
      await client.query('LISTEN cnc_alarm_events');
      backoff = 1000;
      // Subscribe first, then catch up: commits during connection setup are
      // either in this scan or delivered by the subscription, safely both.
      scheduleDrain();
    } catch (error) { disconnected(error); }
    finally { connecting = false; }
  }
  connect();
  return async function stopAlarmNotifications() {
    stopped = true;
    clearTimeout(reconnectTimer); clearTimeout(drainTimer);
    await currentRun?.catch(() => {});
    if (client) {
      const active = client; client = undefined;
      active.removeListener('notification', onNotification);
      let destroy = false;
      try { await active.query('UNLISTEN cnc_alarm_events'); }
      catch { destroy = true; }
      finally {
        // pg can emit a socket error while the UNLISTEN promise rejects.
        // Retain the error handler until that asynchronous work finishes.
        active.removeListener('error', disconnected);
        active.removeListener('end', disconnected);
        active.release(destroy);
      }
    }
  };
}
module.exports = { startAlarmNotifications };
