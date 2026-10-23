/*
 * What one company's AI may cost in a month (23 Oct 2026, the user: "don't
 * let the amount increase; decreasing is fine"). The tokens its questions
 * used this calendar month (company time, assistant_usage) are priced at the
 * model's rates and held against the company's monthly limit — S&T sets it
 * (Company Management → AI): US$5 until then, never above the server's
 * ASSISTANT_COMPANY_MONTHLY_USD. Reached, the AI stops for that company until
 * the month turns — the reports stay open. Every input token is priced as a
 * cache write (1.25×), so the figure is never below what the API bills.
 *
 * With the daily limits this is a second, money-based stop: it holds even
 * if prices or the questions' size change.
 */
const db = require('../db');
const readConfig = require('./assistant.config');

/** A company's monthly limit until S&T sets one, US$. */
const DEFAULT_MONTHLY_USD = 5;

/** US$ for these tokens at the configured rates (per million tokens). */
function costOf({ input = 0, cached = 0, output = 0 }, cfg = readConfig()) {
  return (Number(input) * cfg.priceInputPerM * 1.25 + Number(cached) * cfg.priceCachedPerM + Number(output) * cfg.priceOutputPerM) / 1e6;
}

/** This company's month so far: what it cost, its limit (the allowance's monthly_usd), and when the month turns. */
async function monthOf(user, capUsd) {
  const cfg = readConfig();
  const cap = Math.min(capUsd ?? DEFAULT_MONTHLY_USD, cfg.monthlyBudgetUsd);
  const { rows: [r] } = await db.query(`
    SELECT COALESCE(SUM(u.input_tokens), 0)::bigint  AS input,
           COALESCE(SUM(u.cached_tokens), 0)::bigint AS cached,
           COALESCE(SUM(u.output_tokens), 0)::bigint AS output,
           to_char(date_trunc('month', NOW() AT TIME ZONE c.timezone) + INTERVAL '1 month', 'DD Mon YYYY') AS resets_on
      FROM companies c
      LEFT JOIN assistant_usage u
             ON u.company_id = c.id AND u.day >= date_trunc('month', NOW() AT TIME ZONE c.timezone)::date
     WHERE c.id = $1
     GROUP BY c.timezone`, [user.company_id]);
  const spent = costOf({ input: r?.input, cached: r?.cached, output: r?.output }, cfg);
  return { spent_usd: spent, cap_usd: cap, reached: spent >= cap, resets_on: r?.resets_on ?? null };
}

module.exports = { monthOf, costOf, DEFAULT_MONTHLY_USD };
