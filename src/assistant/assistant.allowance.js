/*
 * The daily allowance: completed answers per person per company day
 * (migration 052). The company admin sets it (50 to start; 0 switches the
 * assistant off for the company). It resets at midnight in the company's
 * timezone. Only a completed answer counts — a clarifying question, a
 * refusal or a failure does not.
 */
const db = require('../db');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** A timezone this server can work in (an IANA name such as Asia/Kolkata). */
function validTimezone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** "12:00 am (Asia/Kolkata)" — when the allowance comes back, where the company is. */
function resetsText(resetsAt, timezone) {
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(resetsAt));
  return `${time} (${timezone})`;
}

/** This person's allowance today, in the company's day. */
async function allowanceOf(user) {
  const { rows: [r] } = await db.query(`
    SELECT COALESCE(s.daily_limit, $3)                     AS daily_limit,
           c.timezone, c.company_name,
           (NOW() AT TIME ZONE c.timezone)::date           AS day,
           (date_trunc('day', NOW() AT TIME ZONE c.timezone) + INTERVAL '1 day') AT TIME ZONE c.timezone AS resets_at,
           COALESCE(u.answers, 0)                          AS used
      FROM companies c
      LEFT JOIN assistant_settings s ON s.company_id = c.id
      LEFT JOIN assistant_usage u
             ON u.company_id = c.id AND u.user_id = $2 AND u.day = (NOW() AT TIME ZONE c.timezone)::date
     WHERE c.id = $1`,
    [user.company_id, user.id, DEFAULT_LIMIT]);
  if (!r) throw fail(403, 'NO_COMPANY', 'No company assigned');
  const limit = Number(r.daily_limit);
  const used = Number(r.used);
  return {
    limit, used, remaining: Math.max(0, limit - used),
    day: r.day, timezone: r.timezone, company_name: r.company_name,
    resets_at: new Date(r.resets_at).toISOString(),
    resets_text: resetsText(r.resets_at, r.timezone)
  };
}

/** Count one completed answer; the allowance after it. */
async function consume(user, allowance) {
  const { rows: [r] } = await db.query(`
    INSERT INTO assistant_usage (user_id, company_id, day, answers) VALUES ($1, $2, $3, 1)
    ON CONFLICT (user_id, company_id, day) DO UPDATE SET answers = assistant_usage.answers + 1
    RETURNING answers`,
    [user.id, user.company_id, allowance.day]);
  const used = Number(r?.answers ?? allowance.used + 1);
  return { ...allowance, used, remaining: Math.max(0, allowance.limit - used) };
}

/** What the browser is told: no internal day key. */
const present = a => a && ({ limit: a.limit, used: a.used, remaining: a.remaining, resets_at: a.resets_at, resets_text: a.resets_text, timezone: a.timezone });

async function settingsOf(user) {
  const a = await allowanceOf(user);
  return { daily_limit: a.limit, timezone: a.timezone, default_limit: DEFAULT_LIMIT, max_limit: MAX_LIMIT };
}

/** The company admin sets the allowance and the company's timezone. */
async function updateSettings(user, body = {}) {
  const limit = body.daily_limit;
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
    throw fail(400, 'BAD_LIMIT', `The daily allowance must be a whole number from 0 to ${MAX_LIMIT}.`);
  }
  if (body.timezone !== undefined && !validTimezone(body.timezone)) {
    throw fail(400, 'BAD_TIMEZONE', 'Choose a timezone from the list, such as Asia/Kolkata.');
  }
  await db.query(`
    INSERT INTO assistant_settings (company_id, daily_limit, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
    ON CONFLICT (company_id) DO UPDATE SET daily_limit = EXCLUDED.daily_limit, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [user.company_id, limit, user.id]);
  if (body.timezone !== undefined) {
    await db.query('UPDATE companies SET timezone = $2, updated_at = NOW() WHERE id = $1', [user.company_id, body.timezone]);
  }
  return settingsOf(user);
}

module.exports = { allowanceOf, consume, present, settingsOf, updateSettings, validTimezone, resetsText, DEFAULT_LIMIT, MAX_LIMIT };
