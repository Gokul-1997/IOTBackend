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
  j.protocol_version, j.controller_ip, j.device_id, j.error_code, j.expires_at,
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
  const { company_id, file_stored_name, backup_stored_name, lease_token,
    gateway_token_version, command_parameters, file_folder, controller_ip, ...rest } = job;
  if (job.protocol_version !== 3 && controller_ip !== undefined) rest.controller_ip = controller_ip;
  return { ...rest, target_file: job.program_name ? targetFile(job.program_path, job.program_name) : null,
           file_name: file_stored_name || job.file_name || null, backup_name: backup_stored_name || job.backup_name || null };
}

/** A gateway operation can finish long after its requester changed company,
 * plant or permissions. Recheck current access before exposing its status.
 * The inbox insert uses that same database snapshot; failure never undoes
 * the already committed controller result. */
async function announceGateway(job, title, message) {
  try {
    const { rows } = await pool.query(`WITH recipient AS (
      SELECT u.id,COALESCE(np.notify_program_transfer,TRUE) AS notify
      FROM users u JOIN companies c ON c.id=u.company_id AND c.is_active=TRUE
      JOIN machines m ON m.id=$6 AND m.company_id=u.company_id AND m.is_active=TRUE
      JOIN permissions p ON p.permission_key='page:programs:view'
      LEFT JOIN notification_preferences np ON np.user_id=u.id
      WHERE u.id=$2 AND u.company_id=$1 AND u.is_active=TRUE
        AND (m.plant_id IS NULL OR EXISTS(SELECT 1 FROM plants plant
          WHERE plant.id=m.plant_id AND plant.company_id=m.company_id AND plant.is_active=TRUE))
        AND (NOT EXISTS(SELECT 1 FROM company_permissions cp WHERE cp.company_id=u.company_id)
          OR EXISTS(SELECT 1 FROM company_permissions cp WHERE cp.company_id=u.company_id AND cp.permission_id=p.id))
        AND (EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
          WHERE ur.user_id=u.id AND r.company_id IS NULL AND r.role_name IN('COMPANY_ADMIN','ADMIN'))
          OR ((u.plant_id IS NULL OR u.plant_id=m.plant_id) AND EXISTS(
            SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id
            WHERE ur.user_id=u.id AND (r.company_id IS NULL OR r.company_id=u.company_id) AND rp.permission_id=p.id)))
    ), inserted AS (
      INSERT INTO notifications(company_id,user_id,type,title,message,link)
      SELECT $1,r.id,$3,$4,$5,'/programs' FROM recipient r WHERE $7::boolean AND r.notify
      RETURNING user_id
    ) SELECT r.id,EXISTS(SELECT 1 FROM inserted) AS inserted FROM recipient r`,
    [job.company_id,job.requested_by,job.status === 'DONE' ? 'INFO' : 'WARNING',title,message,job.machine_id,
      ['DONE','FAILED'].includes(job.status) && job.action !== 'LIST']);
    if (!rows.length) return;
    emitToUser(job.requested_by, 'programJob', view(job));
    if (rows[0].inserted) await announceUnread([job.requested_by]);
  } catch (error) {
    console.error('Program gateway announcement failed:', error.message);
  }
}

/**
 * Tell the person who asked: live on their open screens, and — when the job
 * ended — in their notifications, unless their saved program-transfer
 * preference disables them. Best effort: a notification that fails must
 * never undo the job's own result.
 */
async function announce(job) {
  if (!job || !job.requested_by) return;
  const ok = job.status === 'DONE';
  const what = job.protocol_version === 3
    ? `${({ SEND: 'sent to', RESTORE: 'restored to', BACKUP: 'backed up from', FETCH: 'retrieved from' })[job.action] || 'received from'} ${job.machine_serial}`
    : job.action === 'SEND' ? `sent to ${job.machine_serial}` : `received from ${job.machine_serial}`;
  const title = ok ? `Program ${what}` : `Program transfer failed — ${job.machine_serial}`;
  const message = ok
    ? `"${job.program_name}" was ${what}.` + ((job.backup_stored_name || job.backup_name) ? ` The program it replaced was kept as ${job.backup_stored_name || job.backup_name}.` : '')
    : `"${job.program_name}" was not ${what}. ${job.message || ''}`.trim();
  if (job.protocol_version === 3) return announceGateway(job, title, message);
  emitToUser(job.requested_by, 'programJob', view(job));
  if (!['DONE', 'FAILED'].includes(job.status)) return;
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
      WHERE protocol_version=1 AND ((status = 'DELIVERED' AND delivered_at < NOW() - INTERVAL '${DELIVERED_TIMEOUT_MIN} minutes')
         OR (status = 'QUEUED'    AND requested_at < NOW() - INTERVAL '${QUEUED_TIMEOUT_HOURS} hours'))
      RETURNING id`
  );
  const commands = await pool.query(`UPDATE program_jobs SET status='FAILED',finished_at=NOW(),error_code='DEVICE_TIMEOUT',
    message=CASE status WHEN 'QUEUED' THEN 'The device did not collect the command within 5 minutes. Check its command connection.'
      ELSE 'The device did not confirm completion. Check the controller before retrying.' END
    WHERE protocol_version=2 AND status=ANY($1) AND expires_at<=NOW() RETURNING id`, [OPEN]);
  for (const { id } of [...rows, ...commands.rows]) await announce(await getJob(id));
  // Lazy require avoids the shared jobs ↔ gateway service import cycle.
  const gatewayChanges = await require('./gateway.service').expireStale();
  return rows.length + commands.rows.length + gatewayChanges;
}

module.exports = {
  ONLINE_WINDOW_SEC, DELIVERED_TIMEOUT_MIN, QUEUED_TIMEOUT_HOURS, OPEN,
  JOB_COLUMNS, JOB_JOINS, getJob, view, announce, finish, failStale
};
