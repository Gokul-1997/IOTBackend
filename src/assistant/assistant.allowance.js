/*
 * What the report assistant may use, per company day (migrations 052, 054).
 *
 *   the allowance   completed answers per person per day, set by the company
 *                   admin (50 to start, 0 switches the assistant off) and never
 *                   above ASSISTANT_DAILY_LIMIT_MAX. What the person sees. A
 *                   clarifying question, a refusal or a failure does not count.
 *   the ceilings    every question the model reads counts — answers or not —
 *                   against two hard limits the person does not see: three
 *                   per answer of their allowance (at least 20), and
 *                   ASSISTANT_COMPANY_DAILY_MAX for the whole company. Without
 *                   them, questions that end in a refusal would run the
 *                   platform's AI (and its bill) without end (22 Oct 2026).
 *   the bill        the tokens each person's questions read and wrote.
 *
 * A day is the company's: it resets at midnight in the company's timezone.
 */
const db = require('../db');
const readConfig = require('./assistant.config');

const DEFAULT_LIMIT = 50;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Questions a person may put to the model in a day: three per answer of the allowance, at least 20. */
const questionCap = limit => Math.max(20, limit * 3);
const count = v => Math.max(0, Math.round(Number(v) || 0));

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
           ((NOW() AT TIME ZONE c.timezone)::date)::text   AS day,
           (date_trunc('day', NOW() AT TIME ZONE c.timezone) + INTERVAL '1 day') AT TIME ZONE c.timezone AS resets_at,
           COALESCE(u.answers, 0)                          AS used,
           COALESCE(u.questions, 0)                        AS questions
      FROM companies c
      LEFT JOIN assistant_settings s ON s.company_id = c.id
      LEFT JOIN assistant_usage u
             ON u.company_id = c.id AND u.user_id = $2 AND u.day = (NOW() AT TIME ZONE c.timezone)::date
     WHERE c.id = $1`,
    [user.company_id, user.id, DEFAULT_LIMIT]);
  if (!r) throw fail(403, 'NO_COMPANY', 'No company assigned');
  const limit = Math.min(Number(r.daily_limit), readConfig().dailyLimitMax);     // a ceiling no company setting passes
  const used = Number(r.used);
  return {
    limit, used, remaining: Math.max(0, limit - used), questions: Number(r.questions) || 0,
    day: r.day, timezone: r.timezone, company_name: r.company_name,
    resets_at: new Date(r.resets_at).toISOString(),
    resets_text: resetsText(r.resets_at, r.timezone)
  };
}

/**
 * Take one question from today's ceilings, before the model is asked — in
 * one short company-serialized transaction. A SUM inside an upsert alone
 * cannot protect the company ceiling: different users lock different rows.
 * Answers null when taken, else which ceiling was reached: 'PERSON' or
 * 'COMPANY'.
 */
async function reserveQuestion(user, allowance) {
  const companyMax = readConfig().companyDailyMax;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('assistant-question:' || $1::text, 0))", [user.company_id]);
    const { rows } = await client.query(`
    INSERT INTO assistant_usage AS u (user_id, company_id, day, questions)
    SELECT $1, $2, $3::date, 1
     WHERE (SELECT COALESCE(SUM(questions), 0) FROM assistant_usage WHERE company_id = $2 AND day = $3::date) < $5
    ON CONFLICT (user_id, company_id, day) DO UPDATE SET questions = u.questions + 1
     WHERE u.questions < $4
       AND (SELECT COALESCE(SUM(questions), 0) FROM assistant_usage WHERE company_id = $2 AND day = $3::date) < $5
    RETURNING questions`,
    [user.id, user.company_id, allowance.day, questionCap(allowance.limit), companyMax]);
    if (rows.length) {
      await client.query('COMMIT');
      return null;
    }
    const { rows: [t] } = await client.query(
    `SELECT COALESCE(SUM(questions), 0)::int AS company FROM assistant_usage WHERE company_id = $1 AND day = $2::date`,
    [user.company_id, allowance.day]);
    await client.query('COMMIT');
    return Number(t?.company) >= companyMax ? 'COMPANY' : 'PERSON';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** The question was never read (the model could not be reached): it does not count. */
async function refundQuestion(user, allowance) {
  await db.query(
    `UPDATE assistant_usage SET questions = GREATEST(questions - 1, 0)
      WHERE user_id = $1 AND company_id = $2 AND day = $3::date`,
    [user.id, user.company_id, allowance.day]);
}

/**
 * After a question: one more answer if it was one, and the tokens the model
 * read and wrote for it (input, cache reads, output) — what it costs.
 */
async function record(user, allowance, { answered = false, inputTokens = 0, cachedTokens = 0, outputTokens = 0 } = {}) {
  const { rows: [r] } = await db.query(`
    INSERT INTO assistant_usage AS u (user_id, company_id, day, answers, input_tokens, cached_tokens, output_tokens)
    VALUES ($1, $2, $3::date, $4, $5, $6, $7)
    ON CONFLICT (user_id, company_id, day) DO UPDATE
       SET answers = u.answers + EXCLUDED.answers,
           input_tokens = u.input_tokens + EXCLUDED.input_tokens,
           cached_tokens = u.cached_tokens + EXCLUDED.cached_tokens,
           output_tokens = u.output_tokens + EXCLUDED.output_tokens
     WHERE $4 = 0 OR u.answers < $8
    RETURNING answers`,
    [user.id, user.company_id, allowance.day, answered ? 1 : 0, count(inputTokens), count(cachedTokens), count(outputTokens), allowance.limit]);
  // Two server processes may complete the person's last answer together.
  // Only one wins the atomic update. Keep the loser's token bill, but do
  // not return another completed answer beyond the displayed allowance.
  if (answered && !r) {
    const after = await record(user, allowance, { inputTokens, cachedTokens, outputTokens });
    return { ...after, answer_limited: true };
  }
  const used = Number(r?.answers ?? allowance.used + (answered ? 1 : 0));
  return { ...allowance, used, remaining: Math.max(0, allowance.limit - used) };
}

/** What the browser is told: no internal day key, no ceilings. */
const present = a => a && ({ limit: a.limit, used: a.used, remaining: a.remaining, resets_at: a.resets_at, resets_text: a.resets_text, timezone: a.timezone });

async function settingsOf(user) {
  const a = await allowanceOf(user);
  return { daily_limit: a.limit, timezone: a.timezone, default_limit: DEFAULT_LIMIT, max_limit: readConfig().dailyLimitMax };
}

/** The company admin sets the allowance (up to the platform's ceiling) and the company's timezone. */
async function updateSettings(user, body = {}) {
  const max = readConfig().dailyLimitMax;
  const limit = body.daily_limit;
  if (!Number.isInteger(limit) || limit < 0 || limit > max) {
    throw fail(400, 'BAD_LIMIT', `The daily allowance must be a whole number from 0 to ${max}.`);
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

module.exports = {
  allowanceOf, reserveQuestion, refundQuestion, record, present, settingsOf, updateSettings,
  validTimezone, resetsText, questionCap, DEFAULT_LIMIT
};
