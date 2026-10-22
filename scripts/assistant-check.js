#!/usr/bin/env node
/*
 * Can this server's report assistant ("STM Mexa AI") reach its AI model?
 *
 *   cd <the API folder> && node scripts/assistant-check.js
 *
 * Reads the API's .env, prints the Node version, whether a key is set (only
 * its first characters and length, never the key — nor anything else that
 * looks like one), the model, and the
 * answer to one tiny question — or the provider's reason for refusing it,
 * with what to do. It touches no database. A refused or failed check costs
 * nothing; a working one costs a fraction of a paisa.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const readConfig = require('../src/assistant/assistant.config');
const { post, headersFor } = require('../src/assistant/assistant.model');

const HINTS = [
  [/not scoped to a workspace|anthropic-workspace-id/i, 'This key is not tied to a workspace. Either make a new key inside a workspace (console.anthropic.com → API Keys → Create Key, choose the workspace) and put it in ANTHROPIC_API_KEY, or keep this key and add ANTHROPIC_WORKSPACE_ID=wrkspc_… (console.anthropic.com → Workspaces) to .env. Then restart the API.'],
  [/authentication_error|invalid x-api-key/i, 'The key was refused. Use an API key from console.anthropic.com → API Keys (it starts "sk-ant-"), copied whole, then restart the API.'],
  [/credit balance|billing/i, 'The Anthropic account has no credit. Add credit under console.anthropic.com → Billing, then try again.'],
  [/not_found_error|model/i, 'This account cannot use that model. Set ASSISTANT_MODEL in .env to one it can use (for example claude-sonnet-5-5) and restart the API.'],
  [/permission_error/i, 'The key may not use the API. Check the key\'s workspace and permissions in console.anthropic.com.'],
  [/rate_limit_error|spend/i, 'Too many requests, or the account\'s spending limit was reached. Check limits in console.anthropic.com.']
];

(async () => {
  const cfg = readConfig();
  console.log(`Node:  ${process.version}`);
  console.log(`Key:   ${cfg.apiKey ? `set (${cfg.apiKey.slice(0, 10)}…, ${cfg.apiKey.length} characters)` : 'NOT SET — add ANTHROPIC_API_KEY=… to .env and restart the API'}`);
  console.log(`Model: ${cfg.model}`);
  if (cfg.workspaceIdIsKey) {
    // never print it: it is a secret
    console.log('Workspace: WRONG — ANTHROPIC_WORKSPACE_ID holds an API key, not a workspace id. Put the key in');
    console.log('           ANTHROPIC_API_KEY instead, and delete the ANTHROPIC_WORKSPACE_ID line (or set it to a wrkspc_… id).');
  } else if (cfg.workspaceIdSet && !cfg.workspaceId) {
    console.log('Workspace: not used — ANTHROPIC_WORKSPACE_ID should look like wrkspc_… (console.anthropic.com → Workspaces).');
  } else if (cfg.workspaceId) {
    console.log(`Workspace: ${cfg.workspaceId}`);
  }
  if (cfg.apiKey && !/^sk-ant-api/.test(cfg.apiKey)) {
    console.log('Note:  keys made under console.anthropic.com → API Keys usually start "sk-ant-api"; this key is a different kind.');
  }
  if (!cfg.apiKey || cfg.workspaceIdIsKey) process.exit(1);

  let res;
  try {
    res = await post(cfg.apiUrl, {
      headers: headersFor(cfg),
      body: JSON.stringify({ model: cfg.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word OK.' }] })
    });
  } catch (err) {
    console.log(`FAILED: this server could not reach api.anthropic.com (${err.code || err.message}).`);
    console.log('Check the server\'s outbound internet access / firewall for api.anthropic.com on port 443.');
    process.exit(1);
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok) {
    const text = (body?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    console.log(`OK: the model answered "${text.slice(0, 40)}". The assistant should work — ask it a question.`);
    process.exit(0);
  }
  const reason = `${body?.error?.type || ''} ${body?.error?.message || ''}`.trim();
  console.log(`FAILED: ${res.status} ${reason.slice(0, 300)}`);
  const hint = HINTS.find(([pattern]) => pattern.test(reason));
  if (hint) console.log(hint[1]);
  process.exit(1);
})();
