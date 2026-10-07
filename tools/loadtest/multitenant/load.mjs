// Portal users of every test company at once: dashboards, machine pages,
// reports, and a live-data socket each — with latency, errors and live-data
// isolation reported per company.
//
//   node load.mjs --in mt.json --seconds 300 [--mode realistic|stress]
//                 [--heavy C --heavy-users 10 --heavy-from 60 --heavy-for 120] [--no-sockets] [--tag x]
//
// realistic  each user stays on a page refreshing it as the web app does, then
//            moves on (the page mix of ../apiload.mjs)
// stress     every user asks for a random page, waits 1 s, asks again
// --heavy C  some of company C's users pull exports and reports back to back,
//            no pause, from --heavy-from for --heavy-for seconds: does one
//            company's reporting slow the others down?
// Users sign in through the API (each from its own address). Every socket
// counts the machine updates it receives; one from another company's machine
// is a leak and is reported as such.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { io } = require(new URL('../../../node_modules/socket.io-client', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const mt = JSON.parse(fs.readFileSync(arg('in', 'mt.json'), 'utf8'));
const BASE = arg('base', mt.base);
const SECONDS = Number(arg('seconds', 120));
const MODE = arg('mode', 'realistic');
const TAG = arg('tag', MODE);
const SOCKETS = !process.argv.includes('--no-sockets');
const HEAVY = arg('heavy', null);
const HEAVY_USERS = Number(arg('heavy-users', 10));
const HEAVY_FROM = Number(arg('heavy-from', 0)) * 1000;
const HEAVY_FOR = Number(arg('heavy-for', SECONDS)) * 1000;

const ist = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const today = ist(Date.now()), weekAgo = ist(Date.now() - 6 * 86400000), monthAgo = ist(Date.now() - 29 * 86400000), yesterday = ist(Date.now() - 86400000);
const week = `from=${weekAgo}&to=${today}`;

const pages = {
  live:        { every: 30000, calls: () => ['/api/dashboard'] },
  factory:     { every: 60000, calls: () => ['/api/dashboard/factory'] },
  maintenance: { every: 60000, calls: () => ['/api/dashboard/maintenance'] },
  machine:     { every: 30000, calls: m => [`/api/dashboard/live/${m}`, `/api/dashboard/live/${m}/timeline`, `/api/dashboard/live/${m}/spindle?range=${Math.random() < 0.1 ? '24h' : '1h'}`] },
  oee:         { every: 90000, calls: () => [`/api/dashboard/oee?${week}&page=1&limit=200`] },
  energy:      { every: 90000, calls: () => [`/api/dashboard/energy?${week}&page=1&limit=20`] },
  operators:   { every: 90000, calls: () => [`/api/dashboard/operators?${week}&page=1&limit=10`] },
  downtime:    { every: 90000, calls: () => [`/api/dashboard/downtime?${week}&page=1&limit=20`] },
  alarms:      { every: 90000, calls: () => [`/api/dashboard/alarms?${week}&page=1&limit=20`] },
};
const weights = { live: 30, factory: 12, maintenance: 10, machine: 18, oee: 10, energy: 5, operators: 5, downtime: 5, alarms: 5 };
const pageNames = Object.keys(pages);
const pick = () => { let r = Math.random() * 100; for (const n of pageNames) { r -= weights[n]; if (r <= 0) return n; } return 'live'; };
// what a busy planner pulls: a month of exports, yesterday's reports, a day of machine detail
const heavyCalls = m => [
  `/api/dashboard/oee/export/csv?from=${monthAgo}&to=${today}`, `/api/dashboard/energy/export/csv?from=${monthAgo}&to=${today}`,
  `/api/dashboard/alarms/export/csv?from=${monthAgo}&to=${today}`, `/api/dashboard/downtime/export/csv?from=${monthAgo}&to=${today}`,
  `/api/dashboard/operators/export/csv?from=${monthAgo}&to=${today}`, `/api/reports/production?date=${yesterday}`,
  `/api/reports/hourly-oee?date=${yesterday}`, `/api/reports/production-data?date_from=${monthAgo}&date_to=${today}`,
  `/api/dashboard/live/${m}/spindle?range=24h`, `/api/charts/parts?machine_id=${m}&shift_start_epoch=${Math.floor(Date.now() / 1000) - 86400}`
];

const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))]); };
const t0 = Date.now();
const stats = {};                 // company -> { lat: [], codes: {}, byEp: {}, timeline: {} }
const statFor = k => stats[k] ||= { lat: [], codes: {}, byEp: {}, timeline: {} };
const keyOf = p => p.replace(/\/live\/\d+/, '/live/:id').replace(/\?.*$/, '').replace(/machine_id=\d+/, '');

async function call(company, tok, path, ip, heavy) {
  const st = statFor(heavy ? `${company}(heavy)` : company);
  const ep = keyOf(path);
  const t = performance.now();
  let code;
  try {
    const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${tok}`, 'x-forwarded-for': ip }, signal: AbortSignal.timeout(60000) });
    await res.arrayBuffer();
    code = res.status;
  } catch (e) { code = e.name === 'TimeoutError' ? 'timeout' : 'neterr'; }
  const ms = performance.now() - t;
  if (code === 403) { st.forbidden = (st.forbidden || 0) + 1; return 403; }
  st.lat.push(ms);
  st.codes[code] = (st.codes[code] || 0) + 1;
  (st.byEp[ep] ||= []).push(ms);
  const bucket = Math.floor((Date.now() - t0) / 30000) * 30;
  (st.timeline[bucket] ||= []).push(ms);
  return code;
}

// sign everyone in, each from its own address
async function signIn(email, ip) {
  const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: mt.password }) });
  const j = await res.json();
  if (!j.accessToken) throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(j).slice(0, 120)}`);
  return j.accessToken;
}
const people = [];
let n = 0;
for (const [key, c] of Object.entries(mt.companies)) {
  for (const u of [c.admin, ...c.users]) {
    const ip = `10.${10 + Object.keys(mt.companies).indexOf(key)}.${Math.floor(n / 250)}.${(n % 250) + 1}`; n++;
    people.push({ key, company: c, ip, token: await signIn(u.email, ip) });
  }
}
console.log(`signed in ${people.length} users: ${Object.entries(mt.companies).map(([k, c]) => `${k}:${1 + c.users.length}`).join(' ')}`);

// live-data sockets
const sock = {};                  // company -> { connected, messages, foreign, delays: [] }
const sockets = [];
if (SOCKETS) {
  await Promise.all(people.map(p => new Promise(resolve => {
    const s = sock[p.key] ||= { connected: 0, failed: 0, messages: 0, foreign: 0, delays: [] };
    const own = new Set(p.company.machines.map(m => m.id));
    const so = io(BASE, { auth: { token: p.token }, transports: ['websocket'], reconnection: true, extraHeaders: { 'x-forwarded-for': p.ip } });
    so.on('connect', () => { s.connected++; resolve(); });
    so.on('connect_error', () => { s.failed++; resolve(); });
    so.on('machineUpdate', d => {
      s.messages++;
      if (!own.has(d.machine_id) || d.company_id !== p.company.id) s.foreign++;
      if (d.received_at) s.delays.push(Date.now() - d.received_at * 1000);
    });
    sockets.push(so);
  })));
  console.log(`sockets: ${Object.entries(sock).map(([k, s]) => `${k} ${s.connected} connected, ${s.failed} refused`).join('; ')}`);
}

const end = Date.now() + SECONDS * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function vu(p) {
  const machinesOf = p.company.machines.map(m => m.id);
  const denied = new Set();          // pages this user's role cannot open: the menu does not offer them
  await sleep(Math.random() * (MODE === 'stress' ? 1000 : 15000));
  while (Date.now() < end) {
    let page = pick();
    for (let i = 0; i < 20 && denied.has(page); i++) page = pick();
    if (denied.has(page)) page = 'live';
    const m = machinesOf[Math.floor(Math.random() * machinesOf.length)];
    const open = async () => (await Promise.all(pages[page].calls(m).map(u => call(p.key, p.token, u, p.ip)))).includes(403);
    if (MODE === 'stress') { if (await open()) denied.add(page); await sleep(1000); continue; }
    const stay = Date.now() + 120000 + Math.random() * 180000;
    while (Date.now() < Math.min(stay, end)) {
      if (await open()) { denied.add(page); break; }
      await sleep(pages[page].every);
    }
  }
}
async function heavyVu(p) {
  const machinesOf = p.company.machines.map(m => m.id);
  await sleep(HEAVY_FROM);
  const stop = Math.min(end, t0 + HEAVY_FROM + HEAVY_FOR);
  let i = Math.floor(Math.random() * 10);
  while (Date.now() < stop) {
    const calls = heavyCalls(machinesOf[i % machinesOf.length]);
    await call(p.key, p.token, calls[i++ % calls.length], p.ip, true);
  }
}

const heavyPeople = HEAVY ? people.filter(p => p.key === HEAVY).slice(0, HEAVY_USERS) : [];
await Promise.all([...people.filter(p => !heavyPeople.includes(p)).map(vu), ...heavyPeople.map(heavyVu)]);

const secs = (Date.now() - t0) / 1000;
const result = { tag: TAG, mode: MODE, seconds: SECONDS, users: people.length, heavy: HEAVY ? { company: HEAVY, users: heavyPeople.length, from_s: HEAVY_FROM / 1000, for_s: HEAVY_FOR / 1000 } : null, companies: {} };
for (const [k, st] of Object.entries(stats).sort()) {
  const errors = Object.entries(st.codes).filter(([c]) => !/^2/.test(c)).reduce((a, [, v]) => a + v, 0);
  result.companies[k] = {
    requests: st.lat.length, rps: Number((st.lat.length / secs).toFixed(1)), errors, forbidden_pages: st.forbidden || 0, codes: st.codes,
    p50: pct(st.lat, 50), p95: pct(st.lat, 95), p99: pct(st.lat, 99), max: Math.round(Math.max(...st.lat)),
    p95_by_30s: Object.fromEntries(Object.entries(st.timeline).map(([b, l]) => [b, pct(l, 95)])),
    slowest: Object.entries(st.byEp).map(([ep, l]) => ({ ep, n: l.length, p95: pct(l, 95) })).sort((a, b) => b.p95 - a.p95).slice(0, 4)
  };
}
if (SOCKETS) result.sockets = Object.fromEntries(Object.entries(sock).map(([k, s]) => [k, { connected: s.connected, refused: s.failed, messages: s.messages, foreign: s.foreign, delay_ms_p50: pct(s.delays, 50), delay_ms_p95: pct(s.delays, 95) }]));
console.log('RESULT ' + JSON.stringify(result));
for (const so of sockets) so.close();
process.exit(0);
