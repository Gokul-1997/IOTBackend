// Cross-company isolation probe: every API route, called by company A's users
// with company B's ids, on a local test database.
//
//   node probe.mjs --in mt.json [--src ../../../src] [--writes] [--out probe.json]
//
// Reads (GET): a response leaks when it carries B's marker ("ZZB…") or, for
// replies without names, when it is identical to what B's own admin gets for
// the same request and holds data.
// Writes (--writes): B's rows in every table that has a company_id or a
// machine_id are fingerprinted before and after each request; any change is a
// cross-company write. Afterwards, rows whose company differs from the company
// of the machine / shift / component they point at are counted (a record of
// one company hung off another company's machine).
// Also: every route without a token.
// LOCAL TEST DATABASES ONLY — it changes B's data when a write leaks.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { Pool } = require(new URL('../../../node_modules/pg', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const mt = JSON.parse(fs.readFileSync(arg('in', 'mt.json'), 'utf8'));
if (!mt.db.startsWith('iot_mt')) throw new Error('local iot_mt* databases only');
const SRC = path.resolve(arg('src', new URL('../../../src', import.meta.url).pathname));
const WRITES = process.argv.includes('--writes');
const OUT = arg('out', 'probe.json');
const db = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: mt.db, max: 3 });
const A = mt.companies.A, B = mt.companies.B;

// ── route catalogue, read from the source ───────────────────────────────
function catalogue() {
  const mounts = [...fs.readFileSync(path.join(SRC, 'routes.js'), 'utf8')
    .matchAll(/app\.use\(\s*'([^']+)'\s*,\s*require\('\.\/([^']+)'\)/g)];
  const routes = [];
  for (const [, base, file] of mounts) {
    const src = fs.readFileSync(path.join(SRC, file + '.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const [, method, p] of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) {
      routes.push({ method: method.toUpperCase(), path: (base + (p === '/' ? '' : p)).replace(/\/$/, '') || base });
    }
  }
  return routes.filter((r, i, a) => a.findIndex(x => x.method === r.method && x.path === r.path) === i);
}

// ── B's ids for each path parameter, by the collection it sits in ─────────
const o = B.objects;
function fill(p) {
  const id = (() => {
    if (/\/api\/machines\//.test(p) || /\/live\//.test(p) || /\/programs\/machines\//.test(p)) return B.machines[0].id;
    if (/\/api\/shifts\//.test(p)) return B.shift_ids[0];
    if (/\/api\/operators\//.test(p)) return B.operators[0];
    if (/\/api\/users\//.test(p) || /\/roles\/assign\//.test(p)) return B.users[0].id;
    if (/\/api\/roles\//.test(p)) return B.supervisor_role_id;
    if (/\/api\/companies\//.test(p)) return B.id;
    if (/\/api\/plants\//.test(p)) return B.plant_id;
    if (/\/api\/lines\//.test(p)) return o.line;
    if (/\/api\/components\//.test(p)) return B.machines[0].component_id;
    if (/\/api\/tickets\//.test(p)) return o.ticket;
    if (/\/maintenance\/schedules\//.test(p)) return o.maintenance_schedule;
    if (/\/downtime\/reasons\//.test(p)) return o.downtime_reason;
    if (/\/api\/alarms\//.test(p)) return o.alarm;
    if (/\/api\/notifications\//.test(p)) return o.notification;
    if (/\/preventive\/thresholds\//.test(p)) return o.preventive_threshold;
    if (/\/periodic\/schedules\//.test(p)) return o.periodic_schedule;
    if (/\/api\/plans\//.test(p)) return 1;
    return B.machines[0].id;
  })();
  return p.replace(/:format/g, 'csv').replace(/:plant_id/g, B.plant_id).replace(/:(id|machine_id|machineId)\b/g, id);
}

const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() + 330 * 60000 - 6 * 86400000).toISOString().slice(0, 10);
const nowS = Math.floor(Date.now() / 1000);
const yesterday = new Date(Date.now() + 330 * 60000 - 86400000).toISOString().slice(0, 10);
const queryFor = day => new URLSearchParams({
  machine_id: B.machines[0].id, machineId: B.machines[0].id, machine_ids: B.machines[0].id, shift_id: B.shift_ids[0],
  line_id: o.line, plant_id: B.plant_id, component_id: B.machines[0].component_id, operator_id: B.operators[0],
  company_id: B.id, user_id: B.users[0].id, date: day, from: weekAgo, to: today, from_date: weekAgo, to_date: today,
  start_date: weekAgo, end_date: today, range: '24h', shift_start_epoch: nowS - 6 * 3600, shift_end_epoch: nowS,
  page: 1, limit: 50
}).toString();
// the same for everyone by design: the catalogue of pages and of plans
const GLOBAL = /^GET \/api\/(roles\/(pages|permissions)\/list|plans(\/:id|\/permissions)?)$/;
const body = () => ({
  machine_id: B.machines[0].id, machine_ids: [B.machines[0].id], machines: [{ machine_id: B.machines[0].id, machine_status: 'ALARM' }],
  shift_id: B.shift_ids[0], component_id: B.machines[0].component_id, operator_id: B.operators[0], line_id: o.line,
  plant_id: B.plant_id, user_id: B.users[0].id, role_ids: [B.supervisor_role_id], assigned_to: B.users[0].id,
  assigned_user_id: B.users[0].id, alarm_id: o.alarm, ticket_id: o.ticket, maintenance_schedule_id: o.maintenance_schedule,
  downtime_reason_id: o.downtime_reason, company_id: B.id, title: 'ZZA probe', name: 'ZZA probe', code: 'ZZAPRB',
  description: 'probe', note: 'probe', notes: 'probe', date: today, job_start: new Date().toISOString(),
  started_at: new Date(Date.now() - 3600000).toISOString(), ended_at: new Date().toISOString(),
  scheduled_at: new Date(Date.now() + 86400000).toISOString(), next_due_at: new Date(Date.now() + 5 * 86400000).toISOString(),
  frequency: 'MONTHLY', grace_days: 1, alarm_type: 'ZZA_PROBE', threshold_count: 3, window_hours: 24, due_hours: 48,
  reject_qty: 7, rework_qty: 2, status: 'CLOSED', priority: 'LOW', issue_type: 'OTHER', target: 9, target_qty: 9,
  part_name: 'ZZA probe', part_number: 'ZZAPN', cycle_time: '00:09:00', operator_code: 'ZZA-PRB', operator_name: 'ZZA probe',
  shift_code: 'ZZA-PRB', start_time: '01:00', end_time: '02:00', break_minutes: 0, breaks: [], plant_code: 'ZZAPRB',
  plant_name: 'ZZA probe', machine_serial_no: 'ZZA-PROBE', username: 'zza_probe', email: 'zza.probe@mt.test',
  password: 'ProbePass1!', is_active: false, cost_per_kwh: 99, overload_kw: 99, permission_ids: [1], role_name: 'ZZA probe',
  recipients: ['zza.probe@mt.test'], reason: 'probe', program_name: 'O9999', action: 'SEND', file_ids: [1]
});

const signIn = async email => (await (await fetch(mt.base + '/api/auth/login', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: mt.password }) })).json()).accessToken;
async function call(token, method, url, data) {
  const res = await fetch(mt.base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: res.status, json: /json/.test(res.headers.get('content-type') || ''), text: await res.text() };
}
const holdsData = t => /\d/.test(t.replace(/"(success|status|page|limit|total|totalPages)"\s*:\s*[^,}]+/g, '')) && t.length > 60
  && !/^\s*\{\s*"(message|error)"/.test(t) && !/"data"\s*:\s*\[\s*\]/.test(t);

// ── B's fingerprint, every table with a company_id or machine_id ─────────
const { rows: tableCols } = await db.query(`
  SELECT c.table_name, bool_or(c.column_name = 'company_id') AS has_company, bool_or(c.column_name = 'machine_id') AS has_machine
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name IN ('company_id', 'machine_id')
     AND c.table_name NOT IN ('telemetry_raw', 'telemetry_late', 'audit_logs', 'energy_meter_readings')
   GROUP BY 1 ORDER BY 1`);
const bMachines = B.machines.map(m => m.id);
async function fingerprint() {
  const f = {};
  for (const t of tableCols) {
    const params = [], where = [];
    if (t.has_company) { params.push(B.id); where.push(`company_id = $${params.length}`); }
    if (t.has_machine) { params.push(bMachines); where.push(`machine_id = ANY($${params.length})`); }
    const { rows: [r] } = await db.query(`SELECT count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM ${t.table_name} x WHERE ${where.join(' OR ')}`,
      params);
    f[t.table_name] = `${r.n}:${r.h}`;
  }
  for (const [name, sql] of [
    ['companies', 'SELECT md5(string_agg(x::text, \'|\')) AS h FROM companies x WHERE id = $1'],
    ['user_roles', 'SELECT md5(string_agg(x::text, \'|\' ORDER BY x::text)) AS h FROM user_roles x JOIN users u ON u.id = x.user_id WHERE u.company_id = $1'],
    ['role_permissions', 'SELECT md5(string_agg(x::text, \'|\' ORDER BY x::text)) AS h FROM role_permissions x JOIN roles r ON r.id = x.role_id WHERE r.company_id = $1'],
    ['ticket_status_history', 'SELECT md5(string_agg(x::text, \'|\' ORDER BY x::text)) AS h FROM ticket_status_history x JOIN maintenance_tickets t ON t.id = x.ticket_id WHERE t.company_id = $1'],
  ]) f[name] = (await db.query(sql, [B.id]).catch(e => ({ rows: [{ h: 'ERR ' + e.message }] }))).rows[0].h;
  return f;
}
const diff = (a, b) => Object.keys(b).filter(k => a[k] !== b[k]);

// rows of one company that point at another company's machine / shift / component / operator
async function crossRefs() {
  const out = {};
  const { rows } = await db.query(`
    SELECT c.table_name, array_agg(c.column_name::text) AS cols FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name NOT IN ('telemetry_raw', 'telemetry_late')
       AND c.column_name IN ('company_id', 'machine_id', 'shift_id', 'component_id', 'operator_id') GROUP BY 1`);
  const refs = { machine_id: 'machines', shift_id: 'shifts', component_id: 'components', operator_id: 'operators' };
  for (const { table_name, cols } of rows) {
    if (!cols.includes('company_id')) continue;
    for (const [col, ref] of Object.entries(refs)) {
      if (!cols.includes(col) || table_name === ref) continue;
      const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM ${table_name} x JOIN ${ref} y ON y.id = x.${col}
        WHERE x.company_id IS NOT NULL AND y.company_id IS NOT NULL AND x.company_id <> y.company_id`);
      if (r.n) out[`${table_name}.${col}→${ref}`] = r.n;
    }
  }
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────
const tokens = { aAdmin: await signIn(A.admin.email), aUser: await signIn(A.users[0].email), bAdmin: await signIn(B.admin.email) };
const routes = catalogue().filter(r => !r.path.startsWith('/api/auth') && !r.path.startsWith('/api/device'));
const findings = { reads: [], writes: [], unauthenticated: [], crossRefsBefore: await crossRefs(), crossRefsAfter: null };
console.log(`${routes.length} routes; cross-company references before: ${JSON.stringify(findings.crossRefsBefore)}`);

for (const r of routes.filter(r => r.method === 'GET' && !GLOBAL.test(`GET ${r.path}`))) {
 for (const day of [today, yesterday]) {
  const url = `${fill(r.path)}?${queryFor(day)}`;
  for (const who of ['aAdmin', 'aUser']) {
    const a = await call(tokens[who], 'GET', url);
    const marker = /ZZB/.test(a.text);
    let same = false;
    if (!marker && a.status < 300 && a.json && who === 'aAdmin') {
      const b = await call(tokens.bAdmin, 'GET', url);
      same = b.status < 300 && b.text === a.text && holdsData(b.text);
    }
    if ((marker || same) && !findings.reads.some(f => f.route === `${r.method} ${r.path}` && f.as === who))
      findings.reads.push({ route: `${r.method} ${r.path}`, as: who, day, status: a.status, why: marker ? 'B marker in reply' : 'same reply as B admin, with data', sample: a.text.slice(0, 220) });
  }
  if (day === today) {
    const anon = await call(null, 'GET', url);
    if (anon.status < 400) findings.unauthenticated.push({ route: `${r.method} ${r.path}`, status: anon.status });
  }
 }
}

if (WRITES) {
  const order = ['POST', 'PUT', 'PATCH', 'DELETE'];
  for (const r of routes.filter(r => r.method !== 'GET').sort((x, y) => order.indexOf(x.method) - order.indexOf(y.method))) {
    if (/\/upload|\/programs\/files$|\/permanent$|\/pages\/seed|\/permissions\/seed/.test(r.path)) continue;
    const before = await fingerprint();
    const a = await call(tokens.aAdmin, r.method, fill(r.path), body());
    const after = await fingerprint();
    const changed = diff(before, after);
    if (changed.length) findings.writes.push({ route: `${r.method} ${r.path}`, status: a.status, changed, reply: a.text.slice(0, 200) });
    const anon = await call(null, r.method, fill(r.path), body());
    if (anon.status < 400) findings.unauthenticated.push({ route: `${r.method} ${r.path}`, status: anon.status });
  }
  findings.crossRefsAfter = await crossRefs();
}

fs.writeFileSync(OUT, JSON.stringify(findings, null, 2));
console.log(`\nREAD LEAKS (${findings.reads.length})`);
for (const f of findings.reads) console.log(`  ${f.route}  as ${f.as}  ${f.status}  ${f.why}  ${f.sample.replace(/\s+/g, ' ').slice(0, 140)}`);
if (WRITES) {
  console.log(`\nCROSS-COMPANY WRITES (${findings.writes.length})`);
  for (const f of findings.writes) console.log(`  ${f.route}  ${f.status}  changed: ${f.changed.join(', ')}`);
  console.log(`\nCROSS-COMPANY REFERENCES after the writes: ${JSON.stringify(findings.crossRefsAfter)}`);
}
console.log(`\nWITHOUT A TOKEN, ANSWERED (${findings.unauthenticated.length}): ${findings.unauthenticated.map(f => `${f.route} ${f.status}`).join('; ')}`);
await db.end();
