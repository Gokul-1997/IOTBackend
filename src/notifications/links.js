/*
 * A notification's link to the very record it is about, so the page opens on
 * it and marks it (22 Oct 2026, the user: "the notification I select — that
 * record highlighted, please"):
 *
 *   /alarms?alarm_id=12                         the Alarms page marks that alarm
 *   /alarm-report?view=details&machine_id=7     that machine's alarm details
 *   /dashboard/live/7                           that machine's live page
 *   /programs?machine_id=7&file_id=42           that machine on Program Transfer, the file marked
 *
 * App-relative paths only: the web app opens them with its router, the
 * mobile app by their first segment (/alarms, /alarm-report, /dashboard).
 */

/** page + ?key=value&… for the ids that are set */
function withQuery(page, params) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return query ? `${page}${page.includes('?') ? '&' : '?'}${query}` : page;
}

/** An alarm, on the alarm page this person can open (alarm-notification.service RECIPIENT_SQL). */
function alarmLink(page, { alarmId, machineId }) {
  if (page === '/alarms') return withQuery(page, { alarm_id: alarmId });
  if (page === '/alarm-report') return withQuery(page, { view: 'details', machine_id: machineId });
  if (page === '/dashboard' && machineId) return `/dashboard/live/${encodeURIComponent(machineId)}`;
  return page;
}

/** A program file — or, with no file, the machine — on Program Transfer. */
function programLink(machineId, fileId = null) {
  return withQuery('/programs', { machine_id: machineId, file_id: fileId });
}

module.exports = { withQuery, alarmLink, programLink };
