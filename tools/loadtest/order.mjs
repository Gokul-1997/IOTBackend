// Out-of-order and duplicate readings for 10 machines: what does each collector keep?
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// run from Backend/tools/loadtest; mqtt comes from the collector's node_modules
const mqtt = require(new URL('../../../pms-backend/node_modules/mqtt', import.meta.url).pathname);
const { Pool } = require(new URL('../../node_modules/pg', import.meta.url).pathname);
const db = new Pool({ host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 55432), user: process.env.PGUSER || 'postgres', database: process.env.SIM_DB || 'iot_staging' });
const { rows: ms } = await db.query(`SELECT id, api_key FROM machines WHERE company_id = 900 ORDER BY id DESC LIMIT 10`);
const c = mqtt.connect('mqtt://127.0.0.1:51883', { clientId: 'order-test', clean: true });
await new Promise(r => c.once('connect', r));
const t = Math.floor(Date.now() / 1000);
const pub = (m, time, parts) => new Promise(r => c.publish(`machines/${m.api_key}/telemetry`,
  JSON.stringify({ time, connection: true, machine_status: 'RUN', mode: 'AUTO', parts_count: parts }), { qos: 1 }, r));
for (const m of ms) {
  await pub(m, t, 500); await pub(m, t + 2, 501);
  await pub(m, t + 1, 502);      // older than the last one: out of order
  await pub(m, t + 2, 501);      // exact repeat: duplicate
}
await new Promise(r => setTimeout(r, 3000));
const ids = ms.map(m => m.id);
const raw = await db.query(`SELECT count(*)::int AS n FROM telemetry_raw WHERE machine_id = ANY($1) AND device_time BETWEEN $2 AND $3`, [ids, t, t + 2]);
const late = await db.query(`SELECT reason, count(*)::int AS n FROM telemetry_late WHERE machine_id = ANY($1) AND device_time BETWEEN $2 AND $3 GROUP BY 1`, [ids, t, t + 2]).catch(() => ({ rows: [] }));
console.log('RESULT ' + JSON.stringify({ published: 40, in_telemetry_raw: raw.rows[0].n, in_telemetry_late: late.rows }));
c.end(); await db.end();
