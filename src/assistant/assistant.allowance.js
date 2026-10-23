/*
 * What the report assistant may use, per company day (migrations 052, 054,
 * 058). S&T sets every figure, per company, in Company Management → AI
 * (23 Oct 2026, the user: "only the super admin decides how much — up or
 * down — not the company side"); the company admin sets nothing.
 *
 *   the allowance   completed answers per person per day (50 until S&T sets
 *                   it; 0 switches the assistant off). What the person sees. A
 *                   clarifying question, a refusal or a failure does not count.
 *   the ceilings    every question the model reads counts — answers or not —
 *                   against two limits the person does not see: three per
 *                   answer of their allowance (at least 20), and the
 *                   company's questions a day (50 until S&T sets it). Without
 *                   them, questions that end in a refusal would run the
 *                   platform's AI (and its bill) without end (22 Oct 2026).
 *   the month       what the company's questions may cost in a calendar month
 *                   (US$5 until S&T sets it; assistant.budget).
 *   the bill        the tokens each person's questions read and wrote.
 *
 * No figure passes the server's ASSISTANT_* ceilings (assistant.config). A
 * day is the company's: it resets at midnight in the company's timezone.
 */
const db = require('../db');
const readConfig = require('./assistant.config');
const { costOf, DEFAULT_MONTHLY_USD } = require('./assistant.budget');

/** Each company's figures until S&T sets its own. */
const DEFAULT_LIMIT = 50;
const DEFAULT_COMPANY_LIMIT = 50;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** A stored figure (null: the default), never above the server's ceiling. */
const figure = (stored, fallback, ceiling) => Math.min(stored === null || stored === undefined ? fallback : Number(stored), ceiling);
/** Any of the three at 0: S&T has switched the AI off for the company. */
const switchedOff = a => a.limit === 0 || a.company_limit === 0 || a.monthly_usd === 0;

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
           s.company_daily_limit, s.monthly_budget_usd,
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
  const cfg = readConfig();
  const limit = figure(r.daily_limit, DEFAULT_LIMIT, cfg.dailyLimitMax);
  const used = Number(r.used);
  return {
    limit, used, remaining: Math.max(0, limit - used), questions: Number(r.questions) || 0,
    company_limit: figure(r.company_daily_limit, DEFAULT_COMPANY_LIMIT, cfg.companyDailyMax),
    monthly_usd: figure(r.monthly_budget_usd, DEFAULT_MONTHLY_USD, cfg.monthlyBudgetUsd),
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
  const companyMax = allowance.company_limit ?? figure(null, DEFAULT_COMPANY_LIMIT, readConfig().companyDailyMax);
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

/**
 * What S&T sees for one company: its three figures (with the defaults and
 * the server's ceilings), its timezone, whether S&T gave it the AI, and its
 * use today and this month — questions, answers, and what they cost.
 */
async function companySettings(companyId) {
  const cfg = readConfig();
  const { rows: [c] } = await db.query(`
    SELECT c.id, c.company_name, c.timezone,
           s.daily_limit, s.company_daily_limit, s.monthly_budget_usd, s.updated_at,
           ((NOW() AT TIME ZONE c.timezone)::date)::text AS day,
           EXISTS (SELECT 1 FROM company_permissions cp JOIN permissions p ON p.id = cp.permission_id
                    WHERE cp.company_id = c.id AND p.permission_key LIKE 'page:assistant%') AS granted
      FROM companies c
      LEFT JOIN assistant_settings s ON s.company_id = c.id
     WHERE c.id = $1`, [companyId]);
  if (!c) throw fail(404, 'COMPANY_NOT_FOUND', 'Company not found.');
  const { rows: [u = {}] } = await db.query(`
    SELECT COALESCE(SUM(questions) FILTER (WHERE day = $2::date), 0)::int AS today_questions,
           COALESCE(SUM(answers) FILTER (WHERE day = $2::date), 0)::int   AS today_answers,
           (COUNT(DISTINCT user_id) FILTER (WHERE day = $2::date AND questions > 0))::int AS today_people,
           COALESCE(SUM(questions), 0)::int AS month_questions,
           COALESCE(SUM(answers), 0)::int   AS month_answers,
           COALESCE(SUM(input_tokens), 0)::bigint AS input,
           COALESCE(SUM(cached_tokens), 0)::bigint AS cached,
           COALESCE(SUM(output_tokens), 0)::bigint AS output
      FROM assistant_usage
     WHERE company_id = $1 AND day >= date_trunc('month', $2::date)::date`, [companyId, c.day]);
  return {
    company_id: c.id, company_name: c.company_name, timezone: c.timezone, granted: !!c.granted,
    person_daily: figure(c.daily_limit, DEFAULT_LIMIT, cfg.dailyLimitMax),
    company_daily: figure(c.company_daily_limit, DEFAULT_COMPANY_LIMIT, cfg.companyDailyMax),
    monthly_usd: figure(c.monthly_budget_usd, DEFAULT_MONTHLY_USD, cfg.monthlyBudgetUsd),
    defaults: { person_daily: DEFAULT_LIMIT, company_daily: DEFAULT_COMPANY_LIMIT, monthly_usd: DEFAULT_MONTHLY_USD },
    max: { person_daily: cfg.dailyLimitMax, company_daily: cfg.companyDailyMax, monthly_usd: cfg.monthlyBudgetUsd },
    usage: {
      today: { questions: count(u.today_questions), answers: count(u.today_answers), people: count(u.today_people) },
      month: { questions: count(u.month_questions), answers: count(u.month_answers),
               spent_usd: Math.round(costOf(u, cfg) * 10000) / 10000 }
    },
    updated_at: c.updated_at || null
  };
}

/**
 * S&T sets one company's figures — each from 0 (the AI off for the company)
 * up to the server's ceiling, raised or lowered as S&T decides — and the
 * company's timezone, whose midnight brings the day's allowance back.
 */
async function updateCompanySettings(companyId, body = {}, actor = {}) {
  const cfg = readConfig();
  const { person_daily: person, company_daily: company, monthly_usd: monthly } = body;
  if (!Number.isInteger(person) || person < 0 || person > cfg.dailyLimitMax) {
    throw fail(400, 'BAD_LIMIT', `Answers a day for each person must be a whole number from 0 to ${cfg.dailyLimitMax}.`);
  }
  if (!Number.isInteger(company) || company < 0 || company > cfg.companyDailyMax) {
    throw fail(400, 'BAD_LIMIT', `Questions a day for the whole company must be a whole number from 0 to ${cfg.companyDailyMax}.`);
  }
  if (typeof monthly !== 'number' || !Number.isFinite(monthly) || monthly < 0 || monthly > cfg.monthlyBudgetUsd
      || Math.abs(Math.round(monthly * 100) - monthly * 100) > 1e-6) {
    throw fail(400, 'BAD_BUDGET', `The monthly limit must be an amount in US$ from 0 to ${cfg.monthlyBudgetUsd}, to the cent.`);
  }
  if (body.timezone !== undefined && !validTimezone(body.timezone)) {
    throw fail(400, 'BAD_TIMEZONE', 'Choose a timezone from the list, such as Asia/Kolkata.');
  }
  const { rows: [found] } = await db.query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!found) throw fail(404, 'COMPANY_NOT_FOUND', 'Company not found.');
  await db.query(`
    INSERT INTO assistant_settings (company_id, daily_limit, company_daily_limit, monthly_budget_usd, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (company_id) DO UPDATE
       SET daily_limit = EXCLUDED.daily_limit, company_daily_limit = EXCLUDED.company_daily_limit,
           monthly_budget_usd = EXCLUDED.monthly_budget_usd, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [companyId, person, company, Math.round(monthly * 100) / 100, actor.id ?? null]);
  if (body.timezone !== undefined) {
    await db.query('UPDATE companies SET timezone = $2, updated_at = NOW() WHERE id = $1', [companyId, body.timezone]);
  }
  return companySettings(companyId);
}

module.exports = {
  allowanceOf, reserveQuestion, refundQuestion, record, present, switchedOff, companySettings, updateCompanySettings,
  validTimezone, resetsText, questionCap, DEFAULT_LIMIT, DEFAULT_COMPANY_LIMIT
};
