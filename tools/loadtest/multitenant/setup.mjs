// Three companies of different sizes, created the way a customer is onboarded:
// S&T creates the company and its admin; the admin creates the plant, shifts,
// machines, components, jobs, operators and users through the API.
//
//   node setup.mjs --base http://127.0.0.1:58000 --db iot_mt --out mt.json
//
// Every name carries its company's marker (ZZA / ZZB / ZZC), so a response that
// leaks another company's data can be found by searching it for the marker.
// LOCAL TEST DATABASES ONLY: it sets passwords directly in the database and
// refuses any host but localhost and any database not named iot_mt*.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { Pool } = require(new URL('../../../node_modules/pg', import.meta.url).pathname);
const bcrypt = require(new URL('../../../node_modules/bcryptjs', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:58000');
const DB = arg('db', 'iot_mt');
const OUT = arg('out', 'mt.json');
const HOST = arg('pghost', '127.0.0.1');
if (!['127.0.0.1', 'localhost'].includes(HOST) || !DB.startsWith('iot_mt')) throw new Error('local iot_mt* databases only');
const db = new Pool({ host: HOST, port: Number(arg('pgport', 55432)), user: 'postgres', database: DB, max: 2 });

const COMPANIES = [
  { key: 'A', marker: 'ZZA', name: 'ZZA Alpha Forge',      machines: 20, plan: 'bronze', users: 9 },
  { key: 'B', marker: 'ZZB', name: 'ZZB Beta Castings',    machines: 50, plan: 'silver', users: 35 },
  { key: 'C', marker: 'ZZC', name: 'ZZC Gamma Precision',  machines: 70, plan: 'silver', users: 49 },
];
const PASSWORD = `Mt!${Math.random().toString(36).slice(2, 10)}A9`;   // test accounts only

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}
const login = async (email, password) => (await api(null, 'POST', '/api/auth/login', { email, password })).accessToken;
async function setPassword(userId) {
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(PASSWORD, 10), userId]);
}

// S&T signs in (its password is set here, in the test database)
const { rows: [snt] } = await db.query(`SELECT u.id, u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id
  JOIN roles r ON r.id = ur.role_id WHERE r.role_name = 'SNT_SUPER' ORDER BY u.id LIMIT 1`);
await setPassword(snt.id);
const sntToken = await login(snt.email, PASSWORD);
const plans = Object.fromEntries((await db.query('SELECT id, plan_code FROM plans')).rows.map(r => [r.plan_code, r.id]));

const out = { base: BASE, db: DB, password: PASSWORD, snt: { id: snt.id, email: snt.email }, companies: {} };
for (const c of COMPANIES) {
  const t0 = Date.now();
  const lower = c.marker.toLowerCase();
  const existing = (await db.query('SELECT id FROM companies WHERE company_code = $1', [`MT-${c.key}`])).rows[0];
  if (existing) throw new Error(`company MT-${c.key} exists already (id ${existing.id}): use a fresh database`);

  // 1. S&T: the company, its plan and its admin
  const company = await api(sntToken, 'POST', '/api/companies', {
    company_code: `MT-${c.key}`, company_name: c.name, contact_email: `${lower}@mt.test`,
    plan_id: plans[c.plan], admin_username: `${lower}_admin`, admin_email: `${lower}.admin@mt.test`
  });
  const companyId = company.id;
  await setPassword(company.admin_user.id);
  const adminToken = await login(`${lower}.admin@mt.test`, PASSWORD);

  // 2. The admin sets the company up
  const plant = (await api(adminToken, 'POST', '/api/plants', { plant_code: `${c.marker}-P1`, plant_name: `${c.marker} Plant 1` }));
  const plantId = plant.plant?.id ?? plant.data?.id ?? plant.id;
  for (const [code, start, end] of [['S1', '06:00', '14:00'], ['S2', '14:00', '22:00'], ['S3', '22:00', '06:00']]) {
    await api(adminToken, 'POST', '/api/shifts', { shift_code: `${c.marker}-${code}`, shift_name: `${c.marker} Shift ${code}`,
      start_time: start, end_time: end, break_minutes: 30 });
  }
  // the create answers without the new row; ids are read back from the test database
  const shiftIds = (await db.query('SELECT id FROM shifts WHERE company_id = $1 ORDER BY start_time', [companyId])).rows.map(r => r.id);
  const machines = [];
  for (let i = 1; i <= c.machines; i++) {
    const m = await api(adminToken, 'POST', '/api/machines', {
      machine_serial_no: `${c.marker}-VMC-${String(i).padStart(2, '0')}`, model: 'VL850', controller: 'FANUC 0i-MF',
      plant_id: plantId, hour_rate: 400, program_path: `//${c.marker}-VMC-${i}/programs`
    });
    machines.push({ id: m.data.id, serial: m.data.machine_serial_no });
  }
  const keys = (await db.query('SELECT id, api_key FROM machines WHERE company_id = $1', [companyId])).rows;
  for (const m of machines) m.api_key = keys.find(k => k.id === m.id).api_key;

  for (const m of machines) {
    const comp = await api(adminToken, 'POST', '/api/components', { machine_id: m.id, part_name: `${c.marker}-PART-${m.id}`,
      part_number: `${c.marker}-PN-${m.id}`, cycle_time: '00:01:00', target: 400, multiplication_factor: 1 });
    m.component_id = comp.data?.id ?? comp.id ?? comp.component?.id
      ?? (await db.query('SELECT id FROM components WHERE machine_id = $1 ORDER BY id DESC LIMIT 1', [m.id])).rows[0].id;
    await api(adminToken, 'POST', '/api/jobs/start', { machine_id: m.id, component_id: m.component_id,
      job_start: new Date(Date.now() - 3 * 86400000).toISOString(), target_qty: 400 });
  }
  for (let i = 1; i <= 6; i++) {
    await api(adminToken, 'POST', '/api/operators', { operator_code: `${c.marker}-OP-${i}`, operator_name: `${c.marker} Operator ${i}`,
      shift_id: shiftIds[(i - 1) % 3], machine_ids: [machines[(i - 1) % machines.length].id] });
  }
  const operators = (await db.query('SELECT id FROM operators WHERE company_id = $1 ORDER BY id', [companyId])).rows.map(r => r.id);
  const roles = await api(adminToken, 'GET', '/api/roles');
  const roleList = roles.data ?? roles.roles ?? roles;
  const supervisor = roleList.find(r => /supervisor/i.test(r.role_name)) || roleList[0];
  for (let i = 1; i <= c.users; i++) {
    await api(adminToken, 'POST', '/api/users', { username: `${lower}_u${String(i).padStart(2, '0')}`,
      email: `${lower}.u${i}@mt.test`, password: PASSWORD, role_ids: [supervisor.id] });
  }
  const users = (await db.query(`SELECT id, email FROM users WHERE company_id = $1 AND email LIKE $2 ORDER BY id`, [companyId, `${lower}.u%`])).rows;

  out.companies[c.key] = { id: companyId, marker: c.marker, name: c.name, plan: c.plan,
    admin: { id: company.admin_user.id, email: `${lower}.admin@mt.test` }, plant_id: plantId, shift_ids: shiftIds,
    machines, operators, users, supervisor_role_id: supervisor.id };
  console.log(`${c.key}: company ${companyId}, ${machines.length} machines, ${users.length} users, ${operators.length} operators in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT}`);
await db.end();
