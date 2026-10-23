#!/usr/bin/env node
/*
 * Can this server's report assistant ("Mexa AI") reach its AI model?
 *
 *   cd <the API folder> && node scripts/assistant-check.js
 *
 * Reads the API's .env, prints the Node version, whether a key is set (only
 * its first characters and length, never the key — nor anything else that
 * looks like one), the model, and the
 * answer to one tiny question — or the provider's reason for refusing it,
 * with what to do. It touches no database. A refused or failed check costs
 * nothing; a working one costs a fraction of a paisa.
 *
 * A personal key that is not tied to one workspace must name a workspace on
 * every request (ANTHROPIC_WORKSPACE_ID). When that is what is missing or
 * wrong, the check tries to list the organization's workspaces with the same
 * key, asks the tiny question in the Default one (then the others) and prints
 * the one line to add. An individual account's key may not list them (403):
 * then it prints the two ways to fix it in the Claude Console (23 Oct 2026:
 * two new keys were both of this kind, and the AI said "not available").
 */
const https = require('node:https');
const path = require('path');
const readConfig = require('../src/assistant/assistant.config');
const { post, headersFor } = require('../src/assistant/assistant.model');

const CONSOLE = 'platform.claude.com';

/** The request named no workspace, or one this key cannot use. */
const WORKSPACE_PROBLEM = /not scoped to a workspace|anthropic-workspace-id|workspace\s+`[^`]*`\s+not found/i;

const HINTS = [
  [/authentication_error|invalid x-api-key/i, `The key was refused (wrong, deleted or expired). Copy a key whole from ${CONSOLE}/settings/keys into ANTHROPIC_API_KEY, then restart the API.`],
  [/credit balance|billing/i, `The Anthropic account has no credit. Add credit under Billing on ${CONSOLE}, then try again.`],
  [/not_found_error|model/i, 'This account cannot use that model. Remove ASSISTANT_MODEL from .env (the default is claude-haiku-5-5) and restart the API.'],
  [/permission_error/i, `The key may not use the API. Check its workspace and permissions on ${CONSOLE}.`],
  [/rate_limit_error|spend/i, `Too many requests, or the account's spending limit was reached. Check the limits on ${CONSOLE}.`]
];

/** One tiny question, in `workspaceId` ('' = the key's own workspace). */
function ask(cfg, workspaceId, send = post) {
  return send(cfg.apiUrl, {
    headers: headersFor({ ...cfg, workspaceId }),
    body: JSON.stringify({ model: cfg.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the word OK.' }] })
  });
}

/** A small GET with a JSON answer (no global fetch: the API supports Node versions without it). */
function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('no answer in 15 s')));
    req.on('error', reject);
  });
}

/** The organization's workspaces, Default included (Admin API: an organization admin's key not tied to a workspace). */
async function listWorkspaces(cfg, get = getJson) {
  const url = `${new URL(cfg.apiUrl).origin}/v1/organizations/workspaces?include_default=true&limit=100`;
  let res;
  try { res = await get(url, headersFor({ ...cfg, workspaceId: '' })); } catch (err) { return { error: err.code || err.message }; }
  if (res.status !== 200 || !Array.isArray(res.body?.data)) {
    return { error: `${res.status} ${res.body?.error?.type || ''} ${String(res.body?.error?.message || '').slice(0, 200)}`.trim() };
  }
  return { workspaces: res.body.data.filter(w => !w.archived_at && /^wrkspc_[A-Za-z0-9]+$/.test(String(w.id))) };
}

/** Default first; never the Claude Code workspace, which carries Claude Code's own traffic and limits. */
function candidates(workspaces) {
  const usable = workspaces.filter(w => w.name !== 'Claude Code');
  return [...usable.filter(w => w.name === 'Default'), ...usable.filter(w => w.name !== 'Default')];
}

/** Ask in each workspace in turn until one answers; at most five tries. */
async function findWorkspace(cfg, { get = getJson, send = post } = {}) {
  const listed = await listWorkspaces(cfg, get);
  if (listed.error) return { listError: listed.error, tried: [] };
  const tried = [];
  for (const workspace of candidates(listed.workspaces).slice(0, 5)) {
    let res = null;
    try { res = await ask(cfg, workspace.id, send); } catch { /* unreachable: reported as refused */ }
    const body = res ? await res.json().catch(() => null) : null;
    tried.push({ workspace, ok: !!res?.ok, reason: res ? `${res.status} ${body?.error?.message || ''}`.trim().slice(0, 160) : 'no answer' });
    if (res?.ok) return { found: workspace, tried };
  }
  return { found: null, tried };
}

async function explainWorkspace(cfg, reason, deps) {
  if (cfg.workspaceId && !/not scoped to a workspace/i.test(reason)) {
    console.log(`ANTHROPIC_WORKSPACE_ID (${cfg.workspaceId}) is not a workspace this key may use.`);
  } else {
    console.log('This key is not tied to one workspace, so every request must name one (ANTHROPIC_WORKSPACE_ID).');
  }
  console.log('Looking up your workspaces with the same key…');
  const r = await findWorkspace(cfg, deps);
  if (r.listError) {
    console.log(`This key may not look them up (${r.listError}). Fix it once in the Claude Console — either:`);
    console.log(`  A. Keep this key: on ${CONSOLE}/settings/workspaces copy the ID of the "Default" workspace`);
    console.log(`     (ID column, it starts wrkspc_) and ${cfg.workspaceIdSet ? 'put it in the ANTHROPIC_WORKSPACE_ID line of .env' : 'add this line to .env: ANTHROPIC_WORKSPACE_ID=<that ID>'}.`);
    console.log(`  B. Or make a key tied to one workspace: ${CONSOLE}/settings/keys → Create key → workspace "Default",`);
    console.log('     expiration "Never" → put it in ANTHROPIC_API_KEY, and delete any ANTHROPIC_WORKSPACE_ID line.');
    console.log('Then restart the API (pm2 restart iot-app --update-env) and run this check again.');
    return;
  }
  for (const t of r.tried) console.log(`  ${String(t.workspace.name).padEnd(22)} ${t.workspace.id}  ${t.ok ? 'answers' : `refused: ${t.reason}`}`);
  if (!r.found) {
    console.log(`No workspace answered. On ${CONSOLE}/settings/workspaces, check that this key's account may use the API in one.`);
    return;
  }
  console.log('');
  console.log(cfg.workspaceIdSet ? 'FIX: change the ANTHROPIC_WORKSPACE_ID line in .env to this:' : 'FIX: add this one line to .env (keep every other line):');
  console.log('');
  console.log(`ANTHROPIC_WORKSPACE_ID=${r.found.id}`);
  console.log('');
  console.log('Then restart the API (pm2 restart iot-app --update-env) and run this check again: it should say OK.');
}

/** The check itself: 0 when the model answers, 1 otherwise. */
async function main({ config = readConfig, send = post, get = getJson } = {}) {
  const cfg = config();
  console.log(`Node:  ${process.version}`);
  console.log(`Key:   ${cfg.apiKey ? `set (${cfg.apiKey.slice(0, 10)}…, ${cfg.apiKey.length} characters)` : 'NOT SET — add ANTHROPIC_API_KEY=… to .env and restart the API'}`);
  console.log(`Model: ${cfg.model}`);
  if (cfg.workspaceIdIsKey) {
    // never print it: it is a secret
    console.log('Workspace: WRONG — ANTHROPIC_WORKSPACE_ID holds an API key, not a workspace id. Put the key in');
    console.log('           ANTHROPIC_API_KEY instead, and delete the ANTHROPIC_WORKSPACE_ID line (or set it to a wrkspc_… id).');
  } else if (cfg.workspaceIdSet && !cfg.workspaceId) {
    console.log(`Workspace: not used — ANTHROPIC_WORKSPACE_ID should look like wrkspc_… (${CONSOLE}/settings/workspaces).`);
  } else if (cfg.workspaceId) {
    console.log(`Workspace: ${cfg.workspaceId}`);
  }
  if (!cfg.apiKey || cfg.workspaceIdIsKey) return 1;

  let res;
  try {
    res = await ask(cfg, cfg.workspaceId, send);
  } catch (err) {
    console.log(`FAILED: this server could not reach api.anthropic.com (${err.code || err.message}).`);
    console.log('Check the server\'s outbound internet access / firewall for api.anthropic.com on port 443.');
    return 1;
  }
  const body = await res.json().catch(() => null);
  if (res.ok) {
    const text = (body?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    console.log(`OK: the model answered "${text.slice(0, 40)}". The assistant should work — ask it a question.`);
    return 0;
  }
  const reason = `${body?.error?.type || ''} ${body?.error?.message || ''}`.trim();
  console.log(`FAILED: ${res.status} ${reason.slice(0, 300)}`);
  if (WORKSPACE_PROBLEM.test(reason)) {
    await explainWorkspace(cfg, reason, { get, send });
    return 1;
  }
  const hint = HINTS.find(([pattern]) => pattern.test(reason));
  if (hint) console.log(hint[1]);
  return 1;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  main().then(code => process.exit(code), err => { console.log(`FAILED: ${err.message}`); process.exit(1); });
}

module.exports = { main, WORKSPACE_PROBLEM, candidates, findWorkspace, listWorkspaces };
