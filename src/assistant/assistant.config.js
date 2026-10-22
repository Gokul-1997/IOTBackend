/*
 * The report assistant's settings, read from the server's environment each
 * time (a changed key or model applies without code changes).
 *
 *   ANTHROPIC_API_KEY         required; without it the assistant says it is not on yet
 *   ANTHROPIC_WORKSPACE_ID    only for a key not scoped to a workspace (Anthropic
 *                             then asks which workspace to bill: wrkspc_…)
 *   ASSISTANT_NAME            what people see it called (default "STM Mexa AI")
 *   ASSISTANT_MODEL           default claude-haiku-5-5 — the lowest cost (22 Oct 2026,
 *                             the user: "Haiku, very low cost"); claude-sonnet-5-5 or
 *                             claude-opus-5-5 answer harder questions at a higher price
 *   ASSISTANT_MAX_TOKENS      reply length cap per model call (default 1024)
 *   ASSISTANT_TIMEOUT_MS      one model call (default 45 s)
 *   ASSISTANT_MAX_CONCURRENT  questions answered at once across the server (8)
 *
 * The key stays on the server: the browser never sees it.
 */
const positive = (raw, fallback, max) => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

module.exports = () => ({
  name: String(process.env.ASSISTANT_NAME || '').trim().slice(0, 40) || 'STM Mexa AI',
  apiKey: String(process.env.ANTHROPIC_API_KEY || '').trim(),
  workspaceId: String(process.env.ANTHROPIC_WORKSPACE_ID || '').trim(),
  apiUrl: 'https://api.anthropic.com/v1/messages',
  model: String(process.env.ASSISTANT_MODEL || '').trim() || 'claude-haiku-5-5',
  maxTokens: positive(process.env.ASSISTANT_MAX_TOKENS, 1024, 4096),
  timeoutMs: positive(process.env.ASSISTANT_TIMEOUT_MS, 45000, 120000),
  maxConcurrent: positive(process.env.ASSISTANT_MAX_CONCURRENT, 8, 100)
});
