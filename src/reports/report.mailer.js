/*
 * Large reports go by email.
 *
 * 21 Oct 2026, the user: large data is not downloaded — the report is built
 * in the background, attached to an email and sent, and the screen says only
 * to check the email in 10–15 minutes. There is no Email button.
 *
 * So a download that would be too large (more rows than MAX_DIRECT_ROWS, or
 * a range past MAX_DIRECT_DAYS) is answered 202 with that message at once,
 * and the file is built after the response and emailed to the person who
 * asked — to their own account's address, never one taken from the request:
 * the server's mailbox must not send company data wherever it is told.
 *
 * One such report per person at a time and a few across the server, so
 * repeated clicks cannot pile up builds that hold the database and memory.
 * If building or sending fails, the person is told in the app (the bell)
 * rather than left waiting for an email that is not coming.
 */

const db = require('../db');
const { sendEmail } = require('../utils/nodemailer');
const reportTemplate = require('../utils/nodemailer/emailTemplates/generateReportTemplate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RUNNING = 4;
const running = new Set();             // people with a large report being built

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

async function accountEmail(userId) {
  const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
  return String(rows[0]?.email || '').trim();
}

/**
 * The covering note's filter lines, named from the company's own records —
 * not from labels sent with the request, which would go into the email as
 * they came.
 */
async function filterLabels(companyId, { line_id = null, machine_id = null, shift_id = null, operator_id = null } = {}) {
  if (!line_id && !machine_id && !shift_id && !operator_id) return [];
  const { rows } = await db.query(`
    SELECT 1 AS n, 'Line' AS k, name AS v FROM line WHERE id = $2 AND company_id = $1
    UNION ALL SELECT 2, 'Machine', machine_serial_no FROM machines WHERE id = $3 AND company_id = $1
    UNION ALL SELECT 3, 'Shift', shift_code FROM shifts WHERE id = $4 AND company_id = $1
    UNION ALL SELECT 4, 'Operator', operator_name FROM operators WHERE id = $5 AND company_id = $1
    ORDER BY n`,
    [companyId, line_id, machine_id, shift_id, operator_id]);
  return rows.map(r => `${r.k}: ${r.v}`);
}

async function notifyFailure(user, name, link) {
  try {
    await db.query(
      `INSERT INTO notifications (company_id, user_id, type, title, message, link)
       VALUES ($1, $2, 'REPORT_EMAIL_FAILED', $3, $4, $5)`,
      [user.company_id ?? null, user.id, `${name} was not emailed`,
       'The report could not be prepared or sent. Try again, or choose fewer days or machines.', link]);
    await require('../notifications/notification.service').announceUnread([user.id]);
  } catch (err) {
    console.error('[reports] could not record the failed report:', err.message);
  }
}

/**
 * Answer 202 with the message now; build the file and email it after.
 *
 *   build(): Promise<{ body, filename, rows, columnLabels }>
 *   count:   rows known to be in the report (null when not read yet)
 *   reason:  'rows' (too many rows) | 'range' (longer than three months)
 *   filters: the line / machine / shift / operator ids, named in the note
 *
 * Throws, before answering, when there is no address to send to (400) or a
 * report is already being built for this person / the server is busy (429).
 */
async function emailInstead(req, res, { name, dateFrom, dateTo, count = null, reason = 'rows', filters = {}, link = '/reports', build }) {
  const user = req.user;
  const to = await accountEmail(user.id);
  if (!EMAIL_RE.test(to)) {
    throw fail(400, 'NO_RECIPIENT',
      'This report is too large to download, and your account has no email address to send it to. ' +
      'Add your email in Account Details, or choose fewer days or machines.');
  }
  if (running.has(user.id)) {
    throw fail(429, 'REPORT_IN_PROGRESS',
      'A large report is already being prepared for you. Check your email before asking for another.');
  }
  if (running.size >= MAX_RUNNING) {
    throw fail(429, 'REPORTS_BUSY', 'Several large reports are being prepared right now. Try again in a few minutes.');
  }

  running.add(user.id);
  let filterLines = [];
  try {
    filterLines = await filterLabels(user.company_id, filters);
  } catch (err) {
    running.delete(user.id);
    throw err;
  }
  const size = count ? ` (${count.toLocaleString('en-IN')} rows)` : '';
  res.status(202).json({
    status: 'success',
    data: {
      queued: true, to, rows: count,
      message: `This report is large${size}, so it is being prepared in the background and will be emailed to ${to}. ` +
               'Please check your email in 10–15 minutes.'
    }
  });

  try {
    const file = await build();
    await sendEmail({
      to,
      subject: `${name} — ${dateFrom} to ${dateTo}`,
      html: reportTemplate({
        reportName: name, dateFrom, dateTo, rowCount: file.rows, columnLabels: file.columnLabels,
        filterLines, requestedBy: user.username || `user ${user.id}`, reason
      }),
      text: `${name} for ${dateFrom} to ${dateTo}. ${file.rows} rows attached.`,
      attachments: [{ filename: file.filename, content: file.body }]
    });
    console.log('[reports] emailed', JSON.stringify({ name, to, rows: file.rows, file: file.filename }));
  } catch (err) {
    console.error('[reports] large report failed', { name, to, company_id: user.company_id, error: err.message });
    await notifyFailure(user, name, link);
  } finally {
    running.delete(user.id);
  }
}

module.exports = { emailInstead, filterLabels, _running: running };
