// CPU, memory, database connections and pipeline backlog, every 2 s, while a
// test runs; prints average and peak at the end.
//
//   node sample.mjs --seconds 300 --api-pid N --collector-pid N [--pgdata DIR] [--db iot_mt] [--tag x]
import { createRequire } from 'module';
import fs from 'fs';
import { execSync } from 'child_process';
const require = createRequire(import.meta.url);
const { Pool } = require(new URL('../../../node_modules/pg', import.meta.url).pathname);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', 120));
const API = Number(arg('api-pid')), COLLECTOR = Number(arg('collector-pid'));
const PGDATA = arg('pgdata', null);
const DB = arg('db', 'iot_mt');
const db = new Pool({ host: '127.0.0.1', port: 55432, user: 'postgres', database: DB, max: 1, application_name: 'sampler' });
const postmaster = PGDATA ? Number(fs.readFileSync(`${PGDATA}/postmaster.pid`, 'utf8').split('\n')[0]) : null;

const series = {};
const add = (k, v) => { if (v != null && !Number.isNaN(v)) (series[k] ||= []).push(v); };
const metric = (text, name) => { const m = text.match(new RegExp(`^${name} (\\S+)$`, 'm')); return m ? Number(m[1]) : null; };

const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  const ps = execSync('ps -A -o pid=,ppid=,%cpu=,rss=,comm=').toString().trim().split('\n').map(l => l.trim().split(/\s+/));
  const proc = ps.map(([pid, ppid, cpu, rss, ...c]) => ({ pid: +pid, ppid: +ppid, cpu: +cpu, rss: +rss / 1024, comm: c.join(' ') }));
  const one = pid => proc.find(p => p.pid === pid);
  const sum = list => ({ cpu: list.reduce((a, p) => a + p.cpu, 0), rss: list.reduce((a, p) => a + p.rss, 0) });
  for (const [name, p] of [['api', one(API)], ['collector', one(COLLECTOR)]]) if (p) { add(`${name}_cpu_pct`, p.cpu); add(`${name}_rss_mb`, p.rss); }
  if (postmaster) { const pg = sum(proc.filter(p => p.pid === postmaster || p.ppid === postmaster)); add('postgres_cpu_pct', pg.cpu); add('postgres_rss_mb', pg.rss); }
  const mq = sum(proc.filter(p => /mosquitto$/.test(p.comm))); add('mosquitto_cpu_pct', mq.cpu);
  const rd = sum(proc.filter(p => /redis-server/.test(p.comm))); add('redis_cpu_pct', rd.cpu);
  try {
    const { rows } = await db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'active')::int AS active,
      count(*) FILTER (WHERE application_name = 'iot-api')::int AS api, count(*) FILTER (WHERE application_name = 'mqtt-ingestion')::int AS collector
      FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]);
    add('db_connections', rows[0].total); add('db_active', rows[0].active); add('db_api_connections', rows[0].api); add('db_collector_connections', rows[0].collector);
  } catch { /* the database may be the fault under test */ }
  try {
    const m = await (await fetch('http://127.0.0.1:59100/metrics', { signal: AbortSignal.timeout(1500) })).text();
    add('journal_pending', metric(m, 'pms_journal_pending')); add('ingress_lag_max_s', metric(m, 'pms_ingress_lag_max_seconds'));
    add('writer_last_batch_ms', metric(m, 'pms_writer_last_batch_ms'));
  } catch { }
  try {
    const h = await (await fetch('http://127.0.0.1:58000/health/ready', { signal: AbortSignal.timeout(1500) })).json();
    add('api_pool_waiting', h.db_pool?.waiting); add('api_pool_total', h.db_pool?.total);
  } catch { }
  await new Promise(r => setTimeout(r, 2000));
}
const out = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, { avg: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)), max: Number(Math.max(...v).toFixed(1)) }]));
console.log('SAMPLE ' + JSON.stringify({ tag: arg('tag', 'sample'), seconds: SECONDS, cores: Number(execSync('sysctl -n hw.ncpu').toString()), ...out }));
await db.end();
