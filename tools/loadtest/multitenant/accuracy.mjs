// Do the hourly totals agree with the readings, company by company, while
// every company publishes at once?
//
//   node accuracy.mjs snapshot --in mt.json --out before.json      (before a fleet run)
//   node accuracy.mjs compare  --in mt.json --before before.json --from <epoch s> --to <epoch s>
//
// The snapshot is each company's production_hourly totals. After the run the
// difference is compared with what the readings themselves say: for each
// machine, the time between consecutive readings credited to the earlier
// reading's state (as the collector does), and the part counter's steps.
// Start the run more than 5 minutes after the machines last published, so
// no interval reaches back before it (the collector forgets a machine's last
// reading after 5 minutes).
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { Pool } = require(new URL('../../../node_modules/pg', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const mode = process.argv[2];
const mt = JSON.parse(fs.readFileSync(arg('in', 'mt.json'), 'utf8'));
const db = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: mt.db, max: 2 });
const companies = Object.entries(mt.companies);

async function totals() {
  const out = {};
  for (const [key, c] of companies) {
    const { rows: [r] } = await db.query(
      `SELECT COALESCE(sum(run_seconds), 0)::bigint AS run, COALESCE(sum(idle_seconds), 0)::bigint AS idle,
              COALESCE(sum(produced_qty), 0)::bigint AS parts
         FROM production_hourly WHERE machine_id = ANY($1)`, [c.machines.map(m => m.id)]);
    out[key] = { run: Number(r.run), idle: Number(r.idle), parts: Number(r.parts) };
  }
  return out;
}

if (mode === 'snapshot') {
  fs.writeFileSync(arg('out', 'before.json'), JSON.stringify(await totals()));
  console.log('snapshot written');
} else {
  const before = JSON.parse(fs.readFileSync(arg('before', 'before.json'), 'utf8'));
  const after = await totals();
  const from = Number(arg('from')), to = Number(arg('to'));
  const result = {};
  for (const [key, c] of companies) {
    const { rows: [r] } = await db.query(`
      WITH t AS (
        SELECT machine_id, machine_status, parts_count, device_time,
               LEAD(device_time) OVER w - device_time AS dt,
               LEAD(parts_count) OVER w - parts_count AS dparts
          FROM telemetry_raw
         WHERE machine_id = ANY($1) AND device_time BETWEEN $2 AND $3
        WINDOW w AS (PARTITION BY machine_id ORDER BY device_time))
      SELECT COALESCE(sum(dt) FILTER (WHERE machine_status = 'RUNNING' AND dt <= 300), 0)::bigint AS run,
             COALESCE(sum(dt) FILTER (WHERE machine_status <> 'RUNNING' AND dt <= 300), 0)::bigint AS idle,
             COALESCE(sum(dparts) FILTER (WHERE dparts BETWEEN 1 AND 20), 0)::bigint AS parts,
             count(*)::int AS readings
        FROM t`, [c.machines.map(m => m.id), from, to]);
    const counted = { run: after[key].run - before[key].run, idle: after[key].idle - before[key].idle, parts: after[key].parts - before[key].parts };
    const readings = { run: Number(r.run), idle: Number(r.idle), parts: Number(r.parts) };
    result[key] = { machines: c.machines.length, readings: r.readings, from_readings: readings, in_hourly_table: counted,
      agree: counted.run === readings.run && counted.idle === readings.idle && counted.parts === readings.parts };
  }
  console.log('ACCURACY ' + JSON.stringify(result));
}
await db.end();
