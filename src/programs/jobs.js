/**
 * Program jobs: what is handed to a machine's device, and what happens to it.
 * Shared by the web side (program.service), the device side (device.service)
 * and the cron that fails jobs nobody finished.
 */
const pool = require('../db');
const { emitToUser } = require('../lib/realtime');
const { targetFile } = require('./program-path');
const { announceUnread } = require('../notifications/notification.service');

/** A device that called within this window counts as online (it calls every ~15 s). */
const ONLINE_WINDOW_SEC = 60;
/** A job the device took but never reported on. */
const DELIVERED_TIMEOUT_MIN = 15;
/** A job no device came for. */
const QUEUED_TIMEOUT_HOURS = 24;

const OPEN = ['QUEUED', 'DELIVERED'];

const JOB_COLUMNS = `
  j.id, j.machine_id, j.machine_serial, j.action, j.program_name, j.program_path, j.overwrite, j.status, j.message,
  j.file_id, j.backup_file_id, j.requested_by, j.requested_at, j.delivered_at, j.finished_at,
  u.username AS requested_by_name,
  f.size_bytes AS file_size, f.sha256 AS file_sha256, f.stored_name AS file_stored_name,
  b.stored_name AS backup_stored_name`;

const JOB_JOINS = `
  LEFT JOIN users u         ON u.id = j.requested_by
  LEFT JOIN program_files f ON f.id = j.file_id
  LEFT JOIN program_files b ON b.id = j.backup_file_id`;

async function getJob(jobId, db = pool) {
  const { rows } = await db.query(`SELECT ${JOB_COLUMNS}, j.company_id FROM program_jobs j ${JOB_JOINS} WHERE j.id = $1`, [jobId]);
  return rows[0] || null;
}

/** The fields a person sees about a job (screen, socket, notification link). */
function view(job) {
  if (!job) return null;
  const { company_id, file_stored_name, backup_stored_name, ...rest } = job;
  return { ...rest, target_file: targetFile(job.program_path, job.program_name),
           file_name: file_stored_name || null, backup_name: backup_stored_name || null };
}

/**
 * Tell the person who asked: live on their open screens, and — when the job
 * ended — in their notifications, unless they switched Program transfer off
 * in Settings. Best effort: a notification that fails must never undo the
 * job's own result.
 */
async function announce(job) {
  if (!job || !job.requested_by) return;
  emitToUser(job.requested_by, 'programJob', view(job));

  if (!['DONE', 'FAILED'].includes(job.status)) return;
  const ok = job.status === 'DONE';
  const what = job.action === 'SEND' ? `sent to ${job.machine_serial}` : `received from ${job.machine_serial}`;
  const title = ok ? `Program ${what}` : `Program transfer failed — ${job.machine_serial}`;
  const message = ok
    ? `"${job.program_name}" was ${what}.` + (job.backup_stored_name ? ` The program it replaced was kept as ${job.backup_stored_name}.` : '')
    : `"${job.program_name}" was not ${what}. ${job.message || ''}`.trim();
  try {
    await pool.query(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link)
       SELECT $1, $2, $3, $4, $5, '/programs'
        WHERE NOT EXISTS (SELECT 1 FROM notification_preferences
                           WHERE user_id = $2 AND notify_program_transfer = false)`,
      [job.company_id, job.requested_by, ok ? 'INFO' : 'WARNING', title, message]
    );
  } catch (err) {
    console.error('Program job notification failed:', err.message);
  }
  // their open screens show the new unread count at once
  await announceUnread([job.requested_by]);
}

/** Finish a job that is still open; returns the job, or null when it was not open. */
async function finish(jobId, status, message, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE program_jobs SET status = $2, message = $3, finished_at = NOW()
      WHERE id = $1 AND status = ANY($4)`,
    [jobId, status, message ? String(message).slice(0, 1000) : null, OPEN]
  );
  if (!rowCount) return null;
  const job = await getJob(jobId, db);
  await announce(job);
  return job;
}

/**
 * Fail the jobs nobody finished: taken by a device that never reported, or
 * never taken at all. Run by cron every 5 minutes.
 */
async function failStale() {
  const { rows } = await pool.query(
    `UPDATE program_jobs
        SET status = 'FAILED', finished_at = NOW(),
            message = CASE status
              WHEN 'DELIVERED' THEN 'The machine''s device took this job but did not report back within ${DELIVERED_TIMEOUT_MIN} minutes.'
              ELSE 'No device collected this job within ${QUEUED_TIMEOUT_HOURS} hours — check that the machine''s device is on and online.'
            END
      WHERE (status = 'DELIVERED' AND delivered_at < NOW() - INTERVAL '${DELIVERED_TIMEOUT_MIN} minutes')
         OR (status = 'QUEUED'    AND requested_at < NOW() - INTERVAL '${QUEUED_TIMEOUT_HOURS} hours')
      RETURNING id`
  );
  for (const { id } of rows) await announce(await getJob(id));
  return rows.length;
}

module.exports = {
  ONLINE_WINDOW_SEC, DELIVERED_TIMEOUT_MIN, QUEUED_TIMEOUT_HOURS, OPEN,
  JOB_COLUMNS, JOB_JOINS, getJob, view, announce, finish, failStale
};
