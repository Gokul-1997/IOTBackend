/*
 * One call to the model (Anthropic's Messages API over HTTPS — no SDK to
 * install, and no reliance on the global fetch, which Node versions before
 * 18 do not have). Errors come back as a status and a code the service turns
 * into one of the assistant's own sentences; the provider's wording and the
 * key never reach the browser. The server log keeps the provider's reason —
 * "authentication_error", "credit balance is too low" — never the
 * conversation. scripts/assistant-check.js runs the same call by hand.
 */
const http = require('node:http');
const https = require('node:https');

const fail = (status, code, detail) => Object.assign(new Error(code), { status, code, detail });

/** The API's headers; a key not scoped to a workspace also names the workspace. */
function headersFor(config) {
  return {
    'content-type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
    ...(config.workspaceId ? { 'anthropic-workspace-id': config.workspaceId } : {})
  };
}

/** A small POST: the part of fetch this needs, on any Node version. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
function post(url, { headers = {}, body = '', signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const abort = () => req.destroy(Object.assign(new Error('Model request cancelled'), { name: 'AbortError' }));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const lib = String(url).startsWith('http:') ? http : https;
    req = lib.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          const error = Object.assign(new Error('Model response exceeds the limit'), { code: 'RESPONSE_TOO_LARGE' });
          finish(error);
          req.destroy(error);
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish(null, { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          text: async () => text, json: async () => JSON.parse(text) });
      });
      res.on('error', error => finish(error));
      res.on('aborted', () => finish(new Error('Model response interrupted')));
    });
    req.on('error', error => finish(error));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    req.end(body);
  });
}

async function callModel({ config, system, tools, toolChoice, messages, signal, fetch: send = post }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, config.timeoutMs);
  let res;
  try {
    res = await send(config.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: headersFor(config),
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
    throw fail(503, err.name === 'AbortError' ? 'ASSISTANT_TIMEOUT' : 'ASSISTANT_UNREACHABLE', `${err.code || ''} ${err.message}`.trim());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }

  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    // 429 / 529: the provider is busy — try again shortly; anything else: not available
    const busy = res.status === 429 || res.status === 529;
    const why = `${res.status} ${body?.error?.type || ''}: ${String(body?.error?.message || '').slice(0, 300)}`.trim();
    throw fail(503, busy ? 'ASSISTANT_BUSY' : 'ASSISTANT_UNAVAILABLE', why);
  }
  if (!body || !Array.isArray(body.content)) throw fail(503, 'ASSISTANT_UNAVAILABLE', 'no content in the answer');
  return body;
}

module.exports = { callModel, post, headersFor, MAX_RESPONSE_BYTES };
