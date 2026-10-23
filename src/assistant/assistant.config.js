/*
 * The report assistant's settings, read from the server's environment each
 * time (a changed key or model applies without code changes).
 *
 *   ANTHROPIC_API_KEY         required; without it the assistant says it is not on yet
 *   ANTHROPIC_WORKSPACE_ID    only for a key not scoped to a workspace (Anthropic
 *                             then asks which workspace to bill: wrkspc_…)
 *   ASSISTANT_NAME            what people see it called (default "STM Mexa AI")
 *   ASSISTANT_MODEL           default claude-haiku-5-5 — the lowest cost (22 Oct 2026,
 *                             the user: "Haiku, very low cost"). Keep it: the assistant
 *                             forces a tool call each turn, which Sonnet 5.5 and Opus 5.5
 *                             refuse, and the prices below are Haiku 5.5's
 *   ASSISTANT_MAX_TOKENS      reply length cap per model call (default 800; a reply is
 *                             at most 2,000 characters)
 *   ASSISTANT_TIMEOUT_MS      one model call (default 45 s)
 *   ASSISTANT_MAX_CONCURRENT  questions answered at once across the server (8)
 *
 * What it may cost — the platform pays for every model call, so these are
 * hard ceilings no company setting can pass (22 Oct 2026; 23 Oct 2026, the
 * user: "50 a day per company; never more — less is fine"):
 *
 *   ASSISTANT_COMPANY_DAILY_MAX  questions a day for a whole company, all its
 *                                people together (default 50)
 *   ASSISTANT_DAILY_LIMIT_MAX    the most answers a day a company admin may give
 *                                each person (default 50: the admin may lower it,
 *                                never raise it)
 *   ASSISTANT_COMPANY_MONTHLY_USD  the most one company's questions may cost in a
 *                                calendar month, in US$ (default 5); reached, the AI
 *                                stops for the company until the month turns
 *   ASSISTANT_PRICE_INPUT_PER_M, ASSISTANT_PRICE_CACHED_PER_M, ASSISTANT_PRICE_OUTPUT_PER_M
 *                                the model's US$ per million tokens — Claude Haiku 5.5:
 *                                0.10 input, 0.01 cache read, 0.50 output (prompts up to
 *                                100K tokens; a question here is under 20K)
 *   ASSISTANT_PER_MINUTE         questions a minute from one person (default 6)
 *
 * One question costs about US$0.0007–0.002 (two or three model calls of ~3,500
 * cached and ~1,000–4,000 other input tokens, ~300 output): 50 a day for a
 * month is about US$1.1–3 a company, never more than the monthly ceiling.
 *
 * The key stays on the server: the browser never sees it.
 */
const positive = (raw, fallback, max) => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
/** A positive amount (money, a price) — decimals allowed. */
const amount = (raw, fallback, max) => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

module.exports = () => ({
  name: String(process.env.ASSISTANT_NAME || '').trim().slice(0, 40) || 'STM Mexa AI',
  apiKey: String(process.env.ANTHROPIC_API_KEY || '').trim(),
  // a workspace id looks like wrkspc_…; anything else (a key pasted there by mistake) is not sent
  workspaceId: /^wrkspc_[A-Za-z0-9]+$/.test(String(process.env.ANTHROPIC_WORKSPACE_ID || '').trim())
    ? String(process.env.ANTHROPIC_WORKSPACE_ID).trim() : '',
  workspaceIdIsKey: /^sk-ant-/.test(String(process.env.ANTHROPIC_WORKSPACE_ID || '').trim()),
  workspaceIdSet: !!String(process.env.ANTHROPIC_WORKSPACE_ID || '').trim(),
  apiUrl: 'https://api.anthropic.com/v1/messages',
  model: String(process.env.ASSISTANT_MODEL || '').trim() || 'claude-haiku-5-5',
  maxTokens: positive(process.env.ASSISTANT_MAX_TOKENS, 800, 4096),
  timeoutMs: positive(process.env.ASSISTANT_TIMEOUT_MS, 45000, 120000),
  questionTimeoutMs: positive(process.env.ASSISTANT_QUESTION_TIMEOUT_MS, 90000, 180000),
  maxConcurrent: positive(process.env.ASSISTANT_MAX_CONCURRENT, 8, 100),
  dailyLimitMax: positive(process.env.ASSISTANT_DAILY_LIMIT_MAX, 50, 1000),
  companyDailyMax: positive(process.env.ASSISTANT_COMPANY_DAILY_MAX, 50, 100000),
  monthlyBudgetUsd: amount(process.env.ASSISTANT_COMPANY_MONTHLY_USD, 5, 10000),
  priceInputPerM: amount(process.env.ASSISTANT_PRICE_INPUT_PER_M, 0.10, 100),
  priceCachedPerM: amount(process.env.ASSISTANT_PRICE_CACHED_PER_M, 0.01, 100),
  priceOutputPerM: amount(process.env.ASSISTANT_PRICE_OUTPUT_PER_M, 0.50, 500),
  perMinute: positive(process.env.ASSISTANT_PER_MINUTE, 6, 60)
});
