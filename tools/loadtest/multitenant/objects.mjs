// One of every kind of record each company owns, so the isolation probe has
// something of company B's to ask for by id. Run after setup.mjs.
//
//   node objects.mjs --in mt.json
//
// Created through the API as each company's admin where an endpoint exists;
// alarms and notifications (written by the collector and the engines) go
// straight into the test database. LOCAL TEST DATABASES ONLY.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { Pool } = require(new URL('../../../node_modules/pg', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const IN = arg('in', 'mt.json');
const mt = JSON.parse(fs.readFileSync(IN, 'utf8'));
if (!mt.db.startsWith('iot_mt')) throw new Error('local iot_mt* databases only');
const db = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: mt.db, max: 2 });

async function api(token, method, path, body) {
  const res = await fetch(mt.base + path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}
const idOf = r => r?.data?.id ?? r?.id ?? r?.line?.id ?? r?.ticket?.id ?? r?.data?.[0]?.id;
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

const ONLY = arg('only', null)?.split(',');
const signIn = async email => (await (await fetch(mt.base + '/api/auth/login', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: mt.password }) })).json()).accessToken;
for (const [key, c] of Object.entries(mt.companies)) {
  c.key = key;
  const token = await signIn(c.admin.email);
  const m0 = c.machines[0].id, m1 = c.machines[1].id, s0 = c.shift_ids[0];
  const o = c.objects || {};
  const step = async (name, fn) => { if (ONLY && !ONLY.includes(name)) return; try { o[name] = await fn(); } catch (e) { console.log(`${c.key} ${name}: ${e.message}`); } };

  await step('line', async () => idOf(await api(token, 'POST', '/api/lines', { name: `${c.marker} Line 1`, plant_id: c.plant_id }))
    ?? (await db.query('SELECT id FROM lines WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [c.id])).rows[0]?.id);
  await step('ticket', async () => idOf(await api(token, 'POST', '/api/tickets', { machine_id: m0, title: `${c.marker} spindle noise`,
    description: `${c.marker} ticket`, issue_type: 'BREAKDOWN', priority: { A: 'HIGH', B: 'CRITICAL', C: 'MEDIUM' }[c.key] })));
  await step('maintenance_schedule', async () => idOf(await api(token, 'POST', '/api/maintenance/schedules', { machine_id: m0,
    title: `${c.marker} lube check`, scheduled_at: new Date(Date.now() + 86400000).toISOString() })));
  await step('maintenance_log', async () => idOf(await api(token, 'POST', '/api/maintenance/logs', { machine_id: m0,
    title: `${c.marker} belt replaced`, started_at: new Date(Date.now() - 7200000).toISOString(), technician_name: `${c.marker} Tech` })));
  await step('downtime_reason', async () => idOf(await api(token, 'POST', '/api/downtime/reasons', { code: `${c.marker}R1`, name: `${c.marker} No material` })));
  await step('downtime_event', async () => idOf(await api(token, 'POST', '/api/downtime/events', { machine_id: m0, shift_id: s0,
    downtime_reason_id: o.downtime_reason, started_at: new Date(Date.now() - 3600000).toISOString(),
    ended_at: new Date(Date.now() - 3000000).toISOString(), notes: `${c.marker} waiting` })));
  await step('quality_entry', async () => { await api(token, 'POST', '/api/quality/entry', { machine_id: m0, shift_id: s0, date: today, reject_qty: 3, rework_qty: 1 });
    return (await db.query('SELECT id FROM quality_entries WHERE machine_id = $1 ORDER BY id DESC LIMIT 1', [m0])).rows[0]?.id; });
  await step('preventive_threshold', async () => idOf(await api(token, 'POST', '/api/dashboard/preventive/thresholds', { machine_id: m0,
    alarm_type: `${c.marker}_SERVO`, threshold_count: 3, window_hours: 24, due_hours: 48 }))
    ?? (await db.query('SELECT id FROM alarm_thresholds WHERE company_id = $1 ORDER BY id DESC LIMIT 1', [c.id])).rows[0]?.id);
  await step('periodic_schedule', async () => idOf(await api(token, 'POST', '/api/dashboard/periodic/schedules', { machine_id: m1,
    title: `${c.marker} coolant change`, frequency: 'MONTHLY', next_due_at: new Date(Date.now() + 5 * 86400000).toISOString(), grace_days: 2 })));
  await step('energy_settings', async () => (await api(token, 'POST', '/api/dashboard/energy/settings', { machine_id: m0, cost_per_kwh: 10.95, overload_kw: 25 }), true));
  await step('device_token', async () => (await api(token, 'POST', `/api/programs/machines/${m0}/device-token`, {})).token ? true : true);
  await step('alarm', async () => (await db.query(
    `INSERT INTO machine_alarms (machine_id, company_id, alarm_type, alarm_code, message, severity, started_at, is_resolved)
     VALUES ($1, $2, 'SERVO', '${c.marker}-411', '${c.marker} servo overload', 'HIGH', now() - interval '2 hours', false) RETURNING id`,
    [m0, c.id]).catch(async e => { console.log(`${c.key} alarm insert: ${e.message}`); return { rows: [{}] }; })).rows[0].id);
  await step('notification', async () => (await db.query(
    `INSERT INTO notifications (user_id, company_id, title, message, type) VALUES ($1, $2, '${c.marker} alert', '${c.marker} machine alarm', 'ALARM') RETURNING id`,
    [c.admin.id, c.id]).catch(async e => { console.log(`${c.key} notification insert: ${e.message}`); return { rows: [{}] }; })).rows[0].id);
  c.objects = o;
  console.log(`${c.key}: ${JSON.stringify(o)}`);
}
fs.writeFileSync(IN, JSON.stringify(mt, null, 2));
await db.end();
