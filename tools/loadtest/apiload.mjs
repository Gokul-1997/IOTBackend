// Portal load test: N virtual users on the dashboards, against the API on
// the local staging stack.
//
//   node apiload.mjs --users 100 --seconds 300 --mode realistic|stress [--tag x]
//
// realistic — each user opens a dashboard and stays on it, refreshing the way
//   the web app does (Live 30 s, Factory/Maintenance 60 s, machine page 30 s;
//   OEE/Energy/Operators/Downtime/Alarms reload when the user changes a filter,
//   every 60–120 s), then moves to another page.
// stress — every user asks for a random dashboard, waits 1 s, asks again:
//   the most the portal could be asked for, to find where it saturates.
//
// Tokens are signed with the staging API's JWT secret, as the login would.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jwt = require(new URL('../../node_modules/jsonwebtoken', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const USERS   = Number(arg('users', 100));
const SECONDS = Number(arg('seconds', 120));
const MODE    = arg('mode', 'realistic');
const BASE    = arg('base', 'http://127.0.0.1:58000');
const TAG     = arg('tag', MODE);
const SECRET  = arg('secret', 'staging-jwt-secret-for-load-tests-only-0123456789abcdef');

// the LOADTEST company's admin (100 machines), and S AND T's real data
const people = [
  { user_id: Number(arg('lt_user', 30)), company_id: 900, plant_id: null, machines: [] },
];
const token = p => jwt.sign({ user_id: p.user_id, plant_id: p.plant_id, company_id: p.company_id, user_type: 'COMPANY_ADMIN',
  is_snt_super: false, roles: ['COMPANY_ADMIN'], permissions: [] }, SECRET, { expiresIn: '2h' });

const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() + 330 * 60000 - 6 * 86400000).toISOString().slice(0, 10);
const range = `from=${weekAgo}&to=${today}`;

// what each page asks for, and how often it refreshes on its own (ms)
const pages = {
  live:        { every: 30000, calls: () => ['/api/dashboard'] },
  factory:     { every: 60000, calls: () => [`/api/dashboard/factory`] },
  maintenance: { every: 60000, calls: () => [`/api/dashboard/maintenance`] },
  machine:     { every: 30000, calls: m => [`/api/dashboard/live/${m}`, `/api/dashboard/live/${m}/timeline`, `/api/dashboard/live/${m}/spindle?range=24h`] },
  oee:         { every: 90000, calls: () => [`/api/dashboard/oee?${range}&page=1&limit=200`] },
  energy:      { every: 90000, calls: () => [`/api/dashboard/energy?${range}&page=1&limit=20`] },
  operators:   { every: 90000, calls: () => [`/api/dashboard/operators?${range}&page=1&limit=10`] },
  downtime:    { every: 90000, calls: () => [`/api/dashboard/downtime?${range}&page=1&limit=20`] },
  alarms:      { every: 90000, calls: () => [`/api/dashboard/alarms?${range}&page=1&limit=20`] },
};
const pageNames = Object.keys(pages);
// how people spread over the pages: most watch Live, Factory or a machine
const weights = { live: 30, factory: 12, maintenance: 10, machine: 18, oee: 10, energy: 5, operators: 5, downtime: 5, alarms: 5 };
const pick = () => { let r = Math.random() * 100; for (const n of pageNames) { r -= weights[n]; if (r <= 0) return n; } return 'live'; };

const stats = new Map();       // path key -> { lat: [], codes: {} }
const keyOf = p => p.replace(/\/live\/\d+/, '/live/:id').replace(/\?.*$/, '');
let inflight = 0, maxInflight = 0;

// --xff: each user behind its own address (X-Forwarded-For; the API trusts one proxy hop),
// to measure the backend without the per-address rate limit in the way
const XFF = process.argv.includes('--xff');
async function call(tok, path, ip) {
  const k = keyOf(path);
  const s = stats.get(k) || stats.set(k, { lat: [], codes: {} }).get(k);
  const t0 = performance.now();
  inflight++; maxInflight = Math.max(maxInflight, inflight);
  try {
    const headers = { authorization: `Bearer ${tok}` };
    if (XFF && ip) headers['x-forwarded-for'] = ip;
    const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(30000) });
    await res.arrayBuffer();
    s.codes[res.status] = (s.codes[res.status] || 0) + 1;
  } catch (e) {
    s.codes[e.name === 'TimeoutError' ? 'timeout' : 'neterr'] = (s.codes[e.name === 'TimeoutError' ? 'timeout' : 'neterr'] || 0) + 1;
  } finally {
    inflight--;
    s.lat.push(performance.now() - t0);
  }
}

const machineIds = JSON.parse(arg('machines', '[]'));
const end = Date.now() + SECONDS * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --users-file: one account per virtual user (the per-user rate limit counts accounts)
const userIds = (() => { const f = arg('users-file', null); return f ? JSON.parse(require('fs').readFileSync(f, 'utf8')) : null; })();
async function vu(i) {
  const p = userIds ? { ...people[0], user_id: userIds[i % userIds.length] } : people[0];
  const tok = token(p);
  const ip = `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  await sleep(Math.random() * (MODE === 'stress' ? 1000 : 15000));  // people do not all arrive in the same second
  while (Date.now() < end) {
    const page = pick();
    const m = machineIds[Math.floor(Math.random() * machineIds.length)];
    if (MODE === 'stress') {
      await Promise.all(pages[page].calls(m).map(c => call(tok, c, ip)));
      await sleep(1000);
      continue;
    }
    const stay = Date.now() + 120000 + Math.random() * 180000;
    while (Date.now() < Math.min(stay, end)) {
      await Promise.all(pages[page].calls(m).map(c => call(tok, c, ip)));
      await sleep(pages[page].every);
    }
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => vu(i)));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))]) : null; };
const rows = [];
let total = 0, errors = 0;
for (const [k, s] of [...stats].sort()) {
  const n = s.lat.length; total += n;
  const bad = Object.entries(s.codes).filter(([c]) => !/^2/.test(c)).reduce((a, [, v]) => a + v, 0); errors += bad;
  rows.push({ endpoint: k, n, p50: pct(s.lat, 50), p95: pct(s.lat, 95), p99: pct(s.lat, 99), max: Math.round(Math.max(...s.lat)), codes: JSON.stringify(s.codes) });
}
console.table(rows);
const all = [...stats.values()].flatMap(s => s.lat);
console.log('RESULT ' + JSON.stringify({ tag: TAG, users: USERS, seconds: SECONDS, mode: MODE, requests: total,
  rps: Number((total / ((Date.now() - t0) / 1000)).toFixed(1)), errors, error_pct: Number((errors / Math.max(1, total) * 100).toFixed(2)),
  p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max_inflight: maxInflight, endpoints: rows }));
