// Machine simulator + ingestion probe for the local load test.
//
//   node simulate.mjs --machines 100 --seconds 300 [--burst 0] [--qos 1] [--tag run1]
//
// Every simulated machine has its own MQTT connection and publishes one
// telemetry message per second (the contract: `time` is epoch seconds, so a
// machine cannot usefully send faster). --burst N makes every machine first
// publish N seconds of back-dated readings at once, as a gateway does when it
// flushes its buffer after a network outage.
//
// While publishing, a probe picks one message every second, remembers when
// the broker acknowledged it, and polls the staging DB until that row is in
// telemetry_raw: publish→committed latency. At the end every published
// message is reconciled against the rows in the DB.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// run from Backend/tools/loadtest; mqtt comes from the collector's node_modules
const mqtt = require(new URL('../../../pms-backend/node_modules/mqtt', import.meta.url).pathname);
const { Pool } = require(new URL('../../node_modules/pg', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MACHINES = Number(arg('machines', 100));
const SECONDS  = Number(arg('seconds', 120));
const BURST    = Number(arg('burst', 0));
const QOS      = Number(arg('qos', 1));
const URL      = arg('url', 'mqtt://127.0.0.1:51883');
const TAG      = arg('tag', 'run');
const OFFSET   = Number(arg('offset', 0));        // first machine number (1-based)

const db = new Pool({ host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 55432), user: process.env.PGUSER || 'postgres', database: process.env.SIM_DB || 'iot_staging', max: 4 });
db.on('error', () => {});   // the outage test stops the database under us

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const { rows: machineRows } = await db.query(
  `SELECT id, api_key FROM machines WHERE company_id = 900 ORDER BY id LIMIT $1 OFFSET $2`, [MACHINES, OFFSET]);
if (machineRows.length < MACHINES) throw new Error(`only ${machineRows.length} LOADTEST machines`);

const startEpoch = Math.floor(Date.now() / 1000);
const published = new Map();   // machine_id -> Set(device_time)
let pubOk = 0, pubErr = 0;
const probes = [];             // { machine_id, t, ackedAt, seenAt }

function payload(m, t) {
  const cyc = t % 60;
  const running = cyc < 50;
  return JSON.stringify({
    time: t, connection: true, machine_status: running ? 'RUN' : 'STOP', status: running ? 3 : 1, mode: 'AUTO',
    parts_count: 20000 + Math.floor(t / 60), spindle_load: running ? 30 + (t % 40) : 2, feed_rate: running ? 1200 : 0,
    spindle_speed: running ? 2400 : 0, spindle_motor_temperature: 40,
    servo_axis_load_percent: { X: 10, Y: 6, Z: 22 }, servo_motor_temperature: { X: 34, Y: 33, Z: 35 }
  });
}

const clients = await Promise.all(machineRows.map(m => new Promise((resolve, reject) => {
  const c = mqtt.connect(URL, { clientId: `sim-${TAG}-${m.id}`, clean: true, reconnectPeriod: 1000 });
  c.once('connect', () => resolve({ c, m }));
  c.once('error', reject);
})));
console.log(`connected ${clients.length} simulated machines`);

function publish({ c, m }, t, probe) {
  const set = published.get(m.id) || published.set(m.id, new Set()).get(m.id);
  set.add(t);
  c.publish(`machines/${m.api_key}/telemetry`, payload(m, t), { qos: QOS }, err => {
    if (err) { pubErr++; return; }
    pubOk++;
    if (probe) probe.ackedAt = performance.now();
  });
}

// back-dated burst first (a gateway flushing its buffer)
if (BURST > 0) {
  for (const cl of clients) for (let k = BURST; k >= 1; k--) publish(cl, startEpoch - k);
  console.log(`burst: ${BURST * clients.length} back-dated messages queued`);
}

// probe poller
let polling = true;
(async function poll() {
  while (polling) {
    const pending = probes.filter(p => p.ackedAt && !p.seenAt);
    if (pending.length) try {
      const { rows } = await db.query(
        `SELECT machine_id, device_time FROM telemetry_raw
          WHERE received_at > now() - interval '10 minutes'
            AND (machine_id, device_time) IN (SELECT * FROM unnest($1::int[], $2::bigint[]))`,
        [pending.map(p => p.machine_id), pending.map(p => p.t)]);
      const now = performance.now();
      for (const r of rows) {
        const p = pending.find(x => x.machine_id === r.machine_id && x.t === Number(r.device_time));
        if (p && !p.seenAt) p.seenAt = now;
      }
    } catch { /* the database is down: try again */ }
    await new Promise(r => setTimeout(r, 50));
  }
})();

// one message per machine per second, spread across the second
const t0 = Date.now();
for (let s = 0; s < SECONDS; s++) {
  const t = startEpoch + s;
  const probeIdx = Math.floor(Math.random() * clients.length);
  for (let i = 0; i < clients.length; i++) {
    const probe = i === probeIdx ? { machine_id: clients[i].m.id, t } : null;
    if (probe) probes.push(probe);
    publish(clients[i], t, probe);
  }
  const wait = t0 + (s + 1) * 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  if ((s + 1) % 30 === 0) {
    const lat = probes.filter(p => p.seenAt).map(p => p.seenAt - p.ackedAt);
    console.log(`t+${s + 1}s published=${pubOk} err=${pubErr} probe p50=${pct(lat, 50)?.toFixed(0)}ms p95=${pct(lat, 95)?.toFixed(0)}ms`);
  }
}

// let the pipeline drain, then reconcile
const drainUntil = Date.now() + Number(arg('drain', 20)) * 1000;
while (Date.now() < drainUntil && probes.some(p => p.ackedAt && !p.seenAt)) await new Promise(r => setTimeout(r, 250));
polling = false;
await new Promise(r => setTimeout(r, 2000));

const ids = [...published.keys()];
const { rows: got } = await db.query(
  `SELECT machine_id, count(DISTINCT device_time)::int AS n, count(*)::int AS rows
     FROM telemetry_raw
    WHERE machine_id = ANY($1) AND device_time BETWEEN $2 AND $3
    GROUP BY machine_id`, [ids, startEpoch - BURST - 1, startEpoch + SECONDS + 1]);
const byId = new Map(got.map(r => [r.machine_id, r]));
let expected = 0, stored = 0, duplicates = 0;
for (const [id, set] of published) {
  expected += set.size;
  const r = byId.get(id);
  stored += r ? r.n : 0;
  duplicates += r ? r.rows - r.n : 0;
}
const lat = probes.filter(p => p.seenAt).map(p => p.seenAt - p.ackedAt);
const result = {
  tag: TAG, machines: MACHINES, seconds: SECONDS, burst: BURST,
  published_acked: pubOk, publish_errors: pubErr,
  expected_rows: expected, stored_rows: stored, missing_rows: expected - stored, duplicate_rows: duplicates,
  loss_pct: Number(((expected - stored) / expected * 100).toFixed(3)),
  probes: probes.length, probes_seen: lat.length,
  latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.length ? Math.max(...lat) : null }
};
for (const k of Object.keys(result.latency_ms)) if (result.latency_ms[k] != null) result.latency_ms[k] = Math.round(result.latency_ms[k]);
console.log('RESULT ' + JSON.stringify(result));
for (const { c } of clients) c.end(true);
await db.end();
process.exit(0);
