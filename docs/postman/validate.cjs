#!/usr/bin/env node
// Offline validation only. No credentials, network calls, servers or controllers.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const collection = JSON.parse(fs.readFileSync(path.join(__dirname, 'CNC_Program_Transfer.postman_collection.json')));
const environment = JSON.parse(fs.readFileSync(path.join(__dirname, 'CNC_Program_Transfer.local.postman_environment.json')));
const defaults = Object.fromEntries(environment.values.map(v => [v.key, v.value]));
const requests = [];
function walk(items) { for (const item of items) item.item ? walk(item.item) : requests.push(item); }
walk(collection.item);
assert.equal(requests.length, 20);
assert.equal(defaults.base_url, 'http://localhost:8000');
for (const name of ['email', 'password', 'access_token', 'refresh_token', 'device_token']) assert.equal(defaults[name], '');
for (const [key, value] of Object.entries(defaults)) if (key.startsWith('confirm_')) assert.equal(value, '');
assert.equal(collection.auth.bearer[0].value, '{{access_token}}');
assert.equal(collection.item[4].auth.bearer[0].value, '{{device_token}}');
const scripts = item => (item.event || []).map(e => e.script.exec.join('\n'));
let scriptCount = 0;
for (const item of [collection, ...requests]) {
  for (const source of scripts(item)) { new vm.Script(source); scriptCount++; }
  if (!item.request) continue;
  assert.ok(item.request.url.startsWith('{{base_url}}/api/'));
  for (const example of item.response || []) if (example.body) JSON.parse(example.body);
  if (item.request.body?.mode === 'raw') {
    const expanded = item.request.body.raw.replace(/\{\{([^}]+)\}\}/g, (_, name) => {
      assert.ok(Object.hasOwn(defaults, name), `Unknown variable ${name}`);
      return name.endsWith('_id') ? '7' : 'fixture';
    });
    JSON.parse(expanded);
  }
  if (item.request.body?.mode === 'formdata') {
    assert.ok(!item.request.header.some(h => h.key.toLowerCase() === 'content-type'));
    assert.equal(item.request.body.formdata.find(f => f.key === 'file').type, 'file');
  }
}
function get(name) { const r = requests.find(r => r.name.includes(name)); assert.ok(r, name); return r; }
function execute(item, kind, values = {}, response = { code: 200, body: {} }) {
  const vars = new Map(Object.entries({ ...defaults, ...values }));
  const state = { skipped: false, stopped: false, error: null, vars };
  const expect = actual => ({ to: { include: expected => assert.ok(actual.includes(expected)), equal: expected => assert.equal(actual, expected) } });
  const pm = {
    environment: { get: k => vars.get(k), set: (k, v) => vars.set(k, v), unset: k => vars.delete(k) },
    execution: { skipRequest: () => { state.skipped = true; }, setNextRequest: value => { assert.equal(value, null); state.stopped = true; } },
    response: { code: response.code, json: () => response.body, to: { have: { status: code => assert.equal(response.code, code) } } },
    test: (_name, run) => run(), expect
  };
  try {
    const source = item.event.find(e => e.listen === kind)?.script.exec.join('\n') || '';
    vm.runInNewContext(source, { pm }, { timeout: 500 });
  } catch (e) { state.error = e; }
  return state;
}
const selected = { machine_id: '7', machine_serial: 'VMC-1', device_serial: 'VMC-1', job_id: '11', job_action: 'SEND', program_name: 'O1234.nc' };
let result = execute(collection, 'prerequest');
assert.ok(result.stopped && !result.skipped && !result.error);
result = execute(collection, 'prerequest', { base_url: 'http://example.invalid' });
assert.ok(result.skipped && result.error);
for (const name of ['Set machine program path', 'Create or replace device token', 'Claim next job', 'Report verified controller write DONE', 'Upload program read from controller', 'Report an actual transfer failure', 'Report controller file list']) {
  result = execute(get(name), 'prerequest', selected);
  assert.ok(result.skipped && result.error, `${name} must be guarded`);
}
result = execute(get('Claim next job'), 'prerequest', { ...selected, confirm_claim_job_id: '11' });
assert.ok(!result.skipped && !result.error);
assert.ok(!result.vars.has('confirm_claim_job_id'), 'confirmation consumed');
result = execute(get('Claim next job'), 'test', { ...selected, claimed_job_id: 'older' }, { code: 204, body: null });
assert.ok(!result.error && !result.vars.has('claimed_job_id'), '204 clears stale claimed ID');
const claimed = { id: 11, action: 'SEND', program_name: 'O1234.nc', target_file: '//CNC_MEM/USER/PATH1/O1234.nc', overwrite: false, file: { sha256: 'a'.repeat(64), size: 2048 } };
result = execute(get('Claim next job'), 'test', selected, { code: 200, body: { job: { ...claimed, id: 99 } } });
assert.ok(result.error && !result.vars.has('claimed_job_id'));
assert.equal(result.vars.get('unexpected_claim_id'), '99');
result = execute(get('Claim next job'), 'test', selected, { code: 200, body: { job: claimed } });
assert.ok(!result.error);
const context = Object.fromEntries(result.vars);
result = execute(get('Report verified controller write DONE'), 'prerequest', { ...context, confirm_done_job_id: '11' });
assert.ok(!result.error && !result.skipped);
assert.ok(!result.vars.has('confirm_done_job_id'));
result = execute(get('Report verified controller write DONE'), 'prerequest', { ...context, machine_id: '8', confirm_done_job_id: '11' });
assert.ok(result.skipped && result.error, 'another machine must not complete a claimed job');
result = execute(get('Upload program read from controller'), 'prerequest', { ...context, confirm_fetch_job_id: '11' });
assert.ok(result.skipped && result.error, 'SEND cannot be completed by a FETCH upload');
result = execute(get('Upload controller backup'), 'prerequest', context);
assert.ok(result.skipped && result.error, 'overwrite=false is not an overwrite backup flow');
result = execute(get('Check jobs and capture'), 'test', { ...selected, job_action: 'FETCH', file_id: '' }, { code: 200, body: { data: [{ id: 12, machine_id: 7, action: 'FETCH', status: 'DONE', file_id: 42 }] } });
assert.ok(result.error && result.vars.get('file_id') === '', 'do not take an unrelated completed file');
result = execute(get('Check jobs and capture'), 'test', { ...selected, job_action: 'FETCH', file_id: '' }, { code: 200, body: { data: [{ id: 11, machine_id: 7, action: 'FETCH', status: 'DONE', file_id: 42 }] } });
assert.ok(!result.error);
assert.equal(result.vars.get('file_id'), '42');
console.log(`PASS: ${requests.length} requests, ${scriptCount} scripts, examples, multipart fields, blank secrets and guarded job lifecycle fixtures. No network requests executed.`);
