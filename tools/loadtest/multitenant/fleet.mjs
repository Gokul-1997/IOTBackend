// Every machine of the test companies publishing at once, with per-company
// ingestion latency — the multi-company version of ../simulate.mjs.
//
//   node fleet.mjs --in mt.json --seconds 300 [--outage C:60:240] [--reconnect-at 120] [--tag x]
//
// Each machine has its own MQTT connection and publishes one reading a second.
// --outage C:60:240   company C's gateway loses its link at t=60 s; for 240 s
//                     its readings are buffered, then sent all at once (in
//                     order) when the link returns, and it carries on live —
//                     one company producing a burst while the others are live.
// --reconnect-at 120  every connection drops and reconnects at t=120 s.
// A probe per company per second measures publish → row committed; at the end
// every published reading is reconciled against telemetry_raw, per company.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const mqtt = require(new URL('../../../../pms-backend/node_modules/mqtt', import.meta.url).pathname);
const { Pool } = require(new URL('../../../node_modules/pg', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const mt = JSON.parse(fs.readFileSync(arg('in', 'mt.json'), 'utf8'));
const SECONDS = Number(arg('seconds', 120));
const MQTT_URL = arg('url', 'mqtt://127.0.0.1:51883');
const TAG = arg('tag', 'fleet');
const [outKey, outAt, outFor] = (arg('outage', '') || '::').split(':');
const OUTAGE = outKey ? { key: outKey, at: Number(outAt), secs: Number(outFor) } : null;
const RECONNECT_AT = Number(arg('reconnect-at', -1));

const db = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: mt.db, max: 4 });
db.on('error', () => {});
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]); };

const machines = Object.entries(mt.companies).flatMap(([key, c]) => c.machines.map(m => ({ ...m, key })));
const startEpoch = Math.floor(Date.now() / 1000);
const published = new Map();             // machine id -> Set(device_time)
const probes = [];                       // { key, machine_id, t, ackedAt, seenAt, inOutage }
let pubOk = 0, pubErr = 0;

function payload(m, t) {
  const running = t % 60 < 50;
  return JSON.stringify({
    time: t, connection: true, machine_status: running ? 'RUN' : 'STOP', status: running ? 3 : 1, mode: 'AUTO',
    parts_count: 30000 + Math.floor(t / 60), spindle_load: running ? 30 + (t % 40) : 2, feed_rate: running ? 1200 : 0,
    spindle_speed: running ? 2400 : 0, spindle_motor_temperature: 40,
    servo_axis_load_percent: { X: 10, Y: 6, Z: 22 }, servo_motor_temperature: { X: 34, Y: 33, Z: 35 }
  });
}

const clients = await Promise.all(machines.map(m => new Promise((resolve, reject) => {
  const c = mqtt.connect(MQTT_URL, { clientId: `fleet-${TAG}-${m.id}`, clean: true, reconnectPeriod: 1000 });
  c.once('connect', () => resolve({ c, m }));
  c.once('error', reject);
})));
console.log(`connected ${clients.length} machines (${Object.entries(mt.companies).map(([k, c]) => `${k}:${c.machines.length}`).join(' ')})`);

function publish({ c, m }, t, probe) {
  (published.get(m.id) || published.set(m.id, new Set()).get(m.id)).add(t);
  c.publish(`machines/${m.api_key}/telemetry`, payload(m, t), { qos: 1 }, err => {
    if (err) { pubErr++; return; }
    pubOk++;
    if (probe) probe.ackedAt = performance.now();
  });
}

let polling = true;
(async function poll() {
  while (polling) {
    const pending = probes.filter(p => p.ackedAt && !p.seenAt);
    if (pending.length) try {
      const { rows } = await db.query(
        `SELECT machine_id, device_time FROM telemetry_raw WHERE received_at > now() - interval '15 minutes'
            AND (machine_id, device_time) IN (SELECT * FROM unnest($1::int[], $2::bigint[]))`,
        [pending.map(p => p.machine_id), pending.map(p => p.t)]);
      const now = performance.now();
      for (const r of rows) {
        const p = pending.find(x => x.machine_id === r.machine_id && x.t === Number(r.device_time));
        if (p && !p.seenAt) p.seenAt = now;
      }
    } catch { /* try again */ }
    await new Promise(r => setTimeout(r, 50));
  }
})();

const byKey = {};
for (const cl of clients) (byKey[cl.m.key] ||= []).push(cl);
const buffered = [];                      // C's readings held during its outage
const t0 = Date.now();
for (let s = 0; s < SECONDS; s++) {
  const t = startEpoch + s;
  if (s === RECONNECT_AT) { for (const { c } of clients) c.stream?.destroy(); console.log(`t+${s}s every connection dropped`); }
  const inOutage = OUTAGE && s >= OUTAGE.at && s < OUTAGE.at + OUTAGE.secs;
  if (OUTAGE && s === OUTAGE.at + OUTAGE.secs) {
    for (const [cl, bt] of buffered) publish(cl, bt);
    console.log(`t+${s}s company ${OUTAGE.key} back: ${buffered.length} buffered readings sent at once`);
    buffered.length = 0;
  }
  for (const [key, list] of Object.entries(byKey)) {
    const probeIdx = Math.floor(Math.random() * list.length);
    list.forEach((cl, i) => {
      if (inOutage && key === OUTAGE.key) { buffered.push([cl, t]); return; }
      const probe = i === probeIdx ? { key, machine_id: cl.m.id, t, during: OUTAGE && s >= OUTAGE.at + OUTAGE.secs && s < OUTAGE.at + OUTAGE.secs + 30 } : null;
      if (probe) probes.push(probe);
      publish(cl, t, probe);
    });
  }
  const wait = t0 + (s + 1) * 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if ((s + 1) % 30 === 0) {
    const line = Object.keys(byKey).map(k => { const l = probes.filter(p => p.key === k && p.seenAt).map(p => p.seenAt - p.ackedAt); return `${k} p95=${pct(l, 95)}ms`; }).join(' ');
    console.log(`t+${s + 1}s published=${pubOk} err=${pubErr} ${line}`);
  }
}

const drainUntil = Date.now() + Number(arg('drain', 30)) * 1000;
while (Date.now() < drainUntil && probes.some(p => p.ackedAt && !p.seenAt)) await new Promise(r => setTimeout(r, 250));
polling = false;
await new Promise(r => setTimeout(r, 2000));

const { rows: got } = await db.query(
  `SELECT machine_id, count(DISTINCT device_time)::int AS n, count(*)::int AS rows FROM telemetry_raw
    WHERE machine_id = ANY($1) AND device_time BETWEEN $2 AND $3 GROUP BY machine_id`,
  [[...published.keys()], startEpoch - 1, startEpoch + SECONDS + 1]);
const rowsBy = new Map(got.map(r => [r.machine_id, r]));
const companies = {};
for (const [key, list] of Object.entries(byKey)) {
  let expected = 0, stored = 0, duplicates = 0;
  for (const { m } of list) {
    const set = published.get(m.id) || new Set();
    expected += set.size;
    const r = rowsBy.get(m.id);
    stored += r ? r.n : 0;
    duplicates += r ? r.rows - r.n : 0;
  }
  const lat = probes.filter(p => p.key === key && p.seenAt).map(p => p.seenAt - p.ackedAt);
  const latBurst = probes.filter(p => p.key === key && p.seenAt && p.during).map(p => p.seenAt - p.ackedAt);
  companies[key] = { machines: list.length, expected, stored, missing: expected - stored, duplicates,
    latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.length ? Math.round(Math.max(...lat)) : null },
    ...(OUTAGE ? { latency_ms_in_30s_after_burst: { p50: pct(latBurst, 50), p95: pct(latBurst, 95), max: latBurst.length ? Math.round(Math.max(...latBurst)) : null } } : {}) };
}
console.log('RESULT ' + JSON.stringify({ tag: TAG, seconds: SECONDS, readings_per_second: machines.length, outage: OUTAGE, reconnect_at: RECONNECT_AT >= 0 ? RECONNECT_AT : null,
  published_acked: pubOk, publish_errors: pubErr, companies }));
for (const { c } of clients) c.end(true);
await db.end();
process.exit(0);
