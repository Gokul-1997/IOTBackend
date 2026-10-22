/*
 * One call to the model (Anthropic's Messages API over HTTPS — no SDK to
 * install). Errors come back as a status and a code the service turns into
 * one of the assistant's own sentences; the provider's wording and the key
 * never reach the browser, and only sizes are logged, never the conversation.
 */
const fail = (status, code, detail) => Object.assign(new Error(code), { status, code, detail });

async function callModel({ config, system, tools, toolChoice, messages, fetch: send = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res;
  try {
    res = await send(config.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        system,
        tools,
        tool_choice: toolChoice,
        messages
      })
    });
  } catch (err) {
    throw fail(503, err.name === 'AbortError' ? 'ASSISTANT_TIMEOUT' : 'ASSISTANT_UNREACHABLE', err.message);
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    // 429 / 529: the provider is busy — try again shortly; anything else: not available
    const busy = res.status === 429 || res.status === 529;
    throw fail(503, busy ? 'ASSISTANT_BUSY' : 'ASSISTANT_UNAVAILABLE', `${res.status} ${body?.error?.type || ''}`.trim());
  }
  if (!body || !Array.isArray(body.content)) throw fail(503, 'ASSISTANT_UNAVAILABLE', 'no content');
  return body;
}

module.exports = { callModel };
