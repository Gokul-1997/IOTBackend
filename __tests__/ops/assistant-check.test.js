/*
 * scripts/assistant-check.js — the by-hand check of the AI's connection
 * (23 Oct 2026). A personal key not tied to one workspace failed every
 * question with "not available right now" for a day: the check now names the
 * workspace to add, or — when the key may not list workspaces (an individual
 * account: 403) — the two ways to fix it in the Claude Console. No network:
 * the model call and the workspace listing are fakes; the replies are
 * Anthropic's own wording.
 */
jest.mock('dotenv', () => ({ config: jest.fn() }));
const dotenv = require('dotenv');
const check = require('../../scripts/assistant-check');

const SECRET = 'sk-ant-usr-01THISPARTISSECRETANDMUSTNEVERBEPRINTED';
const NOT_SCOPED = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
const DEFAULT = { id: 'wrkspc_01DefaultAAAAAAAAAAAAAAA', name: 'Default', archived_at: null };
const CLAUDE_CODE = { id: 'wrkspc_01ClaudeCodeBBBBBBBBBBBB', name: 'Claude Code', archived_at: null };
const OTHER = { id: 'wrkspc_01OtherCCCCCCCCCCCCCCCCC', name: 'MEXA', archived_at: null };

const cfg = (over = {}) => ({
  apiKey: SECRET, workspaceId: '', workspaceIdSet: false, workspaceIdIsKey: false,
  apiUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5', ...over
});
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const refusal = (status, type, message) => answer(status, { type: 'error', error: { type, message } });
const ok = answer(200, { content: [{ type: 'text', text: 'OK' }] });

/** A model that answers only in these workspaces ('' = no header) and refuses elsewhere as Anthropic does. */
const modelIn = (...workspaces) => jest.fn(async (url, { headers }) => {
  const ws = headers['anthropic-workspace-id'] || '';
  if (workspaces.includes(ws)) return ok;
  return ws ? refusal(404, 'not_found_error', `Workspace \`${ws}\` not found.`) : refusal(400, 'invalid_request_error', NOT_SCOPED);
});
const listing = (...data) => jest.fn(async () => ({ status: 200, body: { data, has_more: false } }));
const forbidden = jest.fn(async () => ({ status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'Missing permissions. Please check with Anthropic support if you think this is in error.' } } }));

let printed;
beforeEach(() => {
  printed = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => printed.push(args.join(' ')));
});
afterEach(() => jest.restoreAllMocks());
const output = () => printed.join('\n');

test('requiring the script runs nothing and reads no .env', () => {
  expect(dotenv.config).not.toHaveBeenCalled();
  expect(typeof check.main).toBe('function');
});

test('a workspace problem is recognised in each of Anthropic\'s three wordings, and nothing else is', () => {
  expect(check.WORKSPACE_PROBLEM.test(`invalid_request_error ${NOT_SCOPED}`)).toBe(true);
  expect(check.WORKSPACE_PROBLEM.test('invalid_request_error anthropic-workspace-id header must be a valid workspace ID.')).toBe(true);
  expect(check.WORKSPACE_PROBLEM.test('not_found_error Workspace `wrkspc_01abc` not found.')).toBe(true);
  expect(check.WORKSPACE_PROBLEM.test('not_found_error model: claude-haiku-9')).toBe(false);
  expect(check.WORKSPACE_PROBLEM.test('invalid_request_error Your credit balance is too low to access the Anthropic API.')).toBe(false);
  expect(check.WORKSPACE_PROBLEM.test('authentication_error invalid x-api-key')).toBe(false);
});

test('Default is tried first and the Claude Code workspace never', () => {
  expect(check.candidates([OTHER, CLAUDE_CODE, DEFAULT]).map(w => w.name)).toEqual(['Default', 'MEXA']);
});

test('the listing asks for Default too, sends the key but never a workspace, and drops archived or odd ids', async () => {
  const get = listing(DEFAULT, { id: 'wrkspc_01Old', name: 'Old', archived_at: '2026-01-01T00:00:00Z' }, { id: 'not-a-workspace', name: 'Odd' }, OTHER);
  const r = await check.listWorkspaces(cfg({ workspaceId: OTHER.id, workspaceIdSet: true }), get);
  expect(r.workspaces.map(w => w.name)).toEqual(['Default', 'MEXA']);
  const [url, headers] = get.mock.calls[0];
  expect(url).toBe('https://api.anthropic.com/v1/organizations/workspaces?include_default=true&limit=100');
  expect(headers['x-api-key']).toBe(SECRET);
  expect(headers).not.toHaveProperty('anthropic-workspace-id');
});

test('a refused or failed listing comes back as its reason', async () => {
  expect((await check.listWorkspaces(cfg(), forbidden)).error).toBe('403 permission_error Missing permissions. Please check with Anthropic support if you think this is in error.');
  const down = jest.fn(async () => { throw Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }); });
  expect(await check.listWorkspaces(cfg(), down)).toEqual({ error: 'ENOTFOUND' });
});

test('the search stops at the first workspace that answers, in that workspace\'s name', async () => {
  const send = modelIn(OTHER.id);
  const r = await check.findWorkspace(cfg(), { get: listing(CLAUDE_CODE, DEFAULT, OTHER), send });
  expect(r.found).toBe(OTHER);
  expect(r.tried.map(t => [t.workspace.name, t.ok])).toEqual([['Default', false], ['MEXA', true]]);
  expect(r.tried[0].reason).toBe(`404 Workspace \`${DEFAULT.id}\` not found.`);
  expect(send.mock.calls.map(([, req]) => req.headers['anthropic-workspace-id'])).toEqual([DEFAULT.id, OTHER.id]);
});

test('at most five workspaces are tried', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `wrkspc_01W${i}`, name: `W${i}`, archived_at: null }));
  const send = modelIn();
  const r = await check.findWorkspace(cfg(), { get: listing(...many), send });
  expect(r.found).toBeNull();
  expect(send).toHaveBeenCalledTimes(5);
});

describe('the check', () => {
  test('a working key: OK and 0', async () => {
    expect(await check.main({ config: () => cfg(), send: modelIn('') })).toBe(0);
    expect(output()).toMatch(/OK: the model answered "OK"/);
  });

  test('an individual account\'s key (not tied to a workspace, may not list them): the two Console fixes', async () => {
    const send = modelIn();
    expect(await check.main({ config: () => cfg(), send, get: forbidden })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const out = output();
    expect(out).toMatch(/FAILED: 400 invalid_request_error This API key is not scoped to a workspace/);
    expect(out).toMatch(/not tied to one workspace/);
    expect(out).toMatch(/403 permission_error Missing permissions/);
    expect(out).toMatch(/platform\.claude\.com\/settings\/workspaces copy the ID of the "Default" workspace/);
    expect(out).toMatch(/add this line to \.env: ANTHROPIC_WORKSPACE_ID=<that ID>/);
    expect(out).toMatch(/platform\.claude\.com\/settings\/keys → Create key → workspace "Default"/);
    expect(out).toMatch(/pm2 restart iot-app --update-env/);
  });

  test('a key that may list workspaces: the exact line to add, for the workspace that answered', async () => {
    expect(await check.main({ config: () => cfg(), send: modelIn(DEFAULT.id), get: listing(CLAUDE_CODE, DEFAULT) })).toBe(1);
    const out = output();
    expect(out).toMatch(/FIX: add this one line to \.env/);
    expect(out).toContain(`\nANTHROPIC_WORKSPACE_ID=${DEFAULT.id}\n`);
    expect(out).not.toContain(CLAUDE_CODE.id);
  });

  test('a workspace line this key may not use: said as such, and the line to change', async () => {
    const wrong = 'wrkspc_01SomeoneElsesDDDDDDDDD';
    const c = cfg({ workspaceId: wrong, workspaceIdSet: true });
    expect(await check.main({ config: () => c, send: modelIn(DEFAULT.id), get: listing(DEFAULT) })).toBe(1);
    const out = output();
    expect(out).toMatch(new RegExp(`ANTHROPIC_WORKSPACE_ID \\(${wrong}\\) is not a workspace this key may use`));
    expect(out).toMatch(/FIX: change the ANTHROPIC_WORKSPACE_ID line in \.env to this/);
    expect(out).toContain(`ANTHROPIC_WORKSPACE_ID=${DEFAULT.id}`);
  });

  test('api.anthropic.com out of reach: said as such', async () => {
    const send = jest.fn(async () => { throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }); });
    expect(await check.main({ config: () => cfg(), send })).toBe(1);
    expect(output()).toMatch(/could not reach api\.anthropic\.com \(ECONNREFUSED\)/);
  });

  test('an unknown model: back to the default — never a model that refuses the forced tool call', async () => {
    const send = jest.fn(async () => refusal(404, 'not_found_error', 'model: claude-haiku-9'));
    expect(await check.main({ config: () => cfg({ model: 'claude-haiku-9' }), send })).toBe(1);
    expect(output()).toMatch(/Remove ASSISTANT_MODEL from \.env \(the default is claude-haiku-5-5\)/);
    expect(output()).not.toMatch(/sonnet|opus/i);
  });

  test('the key is never printed — only its first ten characters and its length', async () => {
    await check.main({ config: () => cfg(), send: modelIn(DEFAULT.id), get: listing(DEFAULT) });
    await check.main({ config: () => cfg(), send: modelIn(''), get: forbidden });
    expect(output()).toContain(`set (${SECRET.slice(0, 10)}…, ${SECRET.length} characters)`);
    expect(output()).not.toContain(SECRET.slice(0, 11));
  });

  test('no key: says how to add one and asks nothing', async () => {
    const send = jest.fn();
    expect(await check.main({ config: () => cfg({ apiKey: '' }), send })).toBe(1);
    expect(output()).toMatch(/NOT SET — add ANTHROPIC_API_KEY=… to \.env/);
    expect(send).not.toHaveBeenCalled();
  });
});
