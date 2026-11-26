#!/usr/bin/env node
'use strict';
/* Tenant-scoped, restartable maintenance. No implicit environment loading.
 * A verified private backup is written BEFORE each committed data change.
 * CNC rows, production quantities/runtime, tariffs and other tenants survive.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const rebuild = require('./energy-rebuild');
const { validSql } = require('../src/lib/energy-quality');
const DAY = 86400e3;
const COMPANY = 4;
const fields = require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname,
  '../src/dashboard/energy-meter.service.js'), 'utf8').match(/const READING_COLUMNS = (\[[\s\S]*?\]);/)[1]);
const rawFields = ['energy', 'voltage', 'current', 'power'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function options(args) {
  const o = { apply: false, stage: 'cleanup', companyId: null, days: null, envFile: null, backupDir: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') o.apply = true;
    else if (args[i] === '--stage') o.stage = args[++i];
    else if (args[i] === '--company-id') o.companyId = Number(args[++i]);
    else if (args[i] === '--days') o.days = Number(args[++i]);
    else if (args[i] === '--env-file') o.envFile = args[++i];
    else if (args[i] === '--backup-dir') o.backupDir = args[++i];
    else throw Error('Unknown option: ' + args[i]);
  }
  if (o.companyId !== COMPANY || o.days !== 5) throw Error('This approved maintenance is limited to company 4 and five days');
  if (!['cleanup', 'rebuild', 'verify'].includes(o.stage)) throw Error('Invalid stage');
  if (!o.envFile || !o.backupDir) throw Error('Explicit --env-file and --backup-dir are required');
  return o;
}
function operations() {
  return [
    { name: 'meter-old', table: 'energy_meter_readings', time: 'read_at', predicate: 'read_at<$2', delete: true },
    { name: 'raw-old', table: 'telemetry_raw', time: 'received_at',
      predicate: `COALESCE(to_timestamp(device_time),received_at)<$2 AND (${rawFields.map(f => f + ' IS NOT NULL').join(' OR ')})`,
      columns: 'company_id,machine_id,id,received_at::text AS received_at,device_time,energy,voltage,current,power',
      set: rawFields.map(f => f + '=NULL').join(',') },
    { name: 'production-old', table: 'production_hourly', time: 'hour_start', predicate: 'hour_start<$2 AND energy_kwh<>0', set: 'energy_kwh=0' },
    { name: 'gaps-old', table: 'ingest_gaps', time: 'resumed_at', predicate: 'resumed_at<$2 AND unallocated_energy_kwh IS NOT NULL', set: 'unallocated_energy_kwh=NULL' },
    { name: 'late-old', table: 'telemetry_late', time: 'received_at',
      predicate: 'COALESCE(to_timestamp(device_time),received_at)<$2 AND payload IS DISTINCT FROM energy_strip_payload(payload)',
      set: 'payload=energy_strip_payload(payload)' },
    { name: 'meter-invalid', table: 'energy_meter_readings', time: 'read_at',
      predicate: `read_at>=$2 AND (${fields.map(f => `(${f} IS NOT NULL AND NOT (${validSql(f, f)}))`).join(' OR ')})`,
      set: fields.map(f => `${f}=CASE WHEN ${validSql(f, f)} THEN ${f} END`).join(',') },
    { name: 'raw-invalid', table: 'telemetry_raw', time: 'received_at',
      predicate: `COALESCE(to_timestamp(device_time),received_at)>=$2 AND (${rawFields.map(f => `(${f} IS NOT NULL AND NOT (${validSql(f, f)}))`).join(' OR ')})`,
      columns: 'company_id,machine_id,id,received_at::text AS received_at,device_time,energy,voltage,current,power',
      set: rawFields.map(f => `${f}=CASE WHEN ${validSql(f, f)} THEN ${f} END`).join(',') }
  ];
}
function backup(dir, name, lines) {
  const data = Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''));
  const bytes = zlib.gzipSync(data);
  const filename = path.join(dir, name + '-' + crypto.randomUUID() + '.jsonl.gz');
  fs.writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
  const fd=fs.openSync(filename,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const disk = fs.readFileSync(filename);
  if (hash(zlib.gunzipSync(disk)) !== hash(data)) throw Error('Backup verification failed');
  return { file: path.basename(filename), sha256: hash(disk), rows: lines.length };
}
function save(dir, manifest) {
  const tmp = path.join(dir, 'manifest.tmp');
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, 'manifest.json'));
}
async function mutate(client, dir, manifest, op, from, to, log) {
  const key = `${op.name}:${from}:${to}`;
  const coverage=new RegExp('^'+op.name+':([^Z]+Z):([^Z]+Z)$');
  if (manifest.completed.some(done=>{
    if(done===key)return true;
    const range=coverage.exec(done);
    return range&&Date.parse(range[1])<=Date.parse(from)&&Date.parse(range[2])>=Date.parse(to);
  })) return;
  const predicate = `company_id=$1 AND (${op.predicate}) AND ${op.time}>=$3 AND ${op.time}<$4`;
  const params = [COMPANY, manifest.cutoff, from, to];
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL iot.energy_retention_cleanup='on'");
    const serialized=['energy_meter_readings','telemetry_raw'].includes(op.table)?'jsonb_strip_nulls(to_jsonb(backup_row))':'row_to_json(backup_row)';
    const result = await client.query(`SELECT ${serialized}::text AS line FROM
      (SELECT ${op.columns || '*'} FROM ${op.table} WHERE ${predicate}) backup_row`, params);
    const item = result.rows.length ? backup(dir, op.name, result.rows.map(row => row.line)) : null;
    if (item) {
      // Persist recovery information even if the subsequent SQL/commit fails.
      manifest.backups.push({ ...item, operation: key }); save(dir, manifest);
      const changed = await client.query(op.delete ? `DELETE FROM ${op.table} WHERE ${predicate}`
        : `UPDATE ${op.table} SET ${op.set} WHERE ${predicate}`, params);
      if (changed.rowCount !== result.rows.length) throw Error('Backup/change row counts differ');
    }
    await client.query('COMMIT');
    manifest.completed.push(key); save(dir, manifest);
    if (item) log({ operation: op.name, through: to, changed: item.rows });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function clearDerived(client, dir, manifest) {
  if (manifest.derived_cleared) return;
  await client.query('BEGIN');
  try {
    for (const table of ['energy_counter_intervals', 'energy_meter_latest', 'energy_counter_state',
      'energy_reconcile_queue', 'energy_refresh_queue', 'energy_backfill_windows']) {
      const { rows } = await client.query(`SELECT row_to_json(t)::text AS line FROM ${table} t WHERE company_id=$1`, [COMPANY]);
      if (rows.length) { manifest.backups.push({ ...backup(dir, table, rows.map(r => r.line)), operation: 'rebuild-derived' }); save(dir, manifest); }
      await client.query(`DELETE FROM ${table} WHERE company_id=$1`, [COMPANY]);
    }
    await client.query('COMMIT'); manifest.derived_cleared = true; save(dir, manifest);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function verify(pool, cutoff) {
  const result = {};
  for (const op of operations()) {
    const { rows: [row] } = await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${op.table}
      WHERE company_id=$1 AND (${op.predicate})`, [COMPANY, cutoff]);
    result[op.name] = row.n;
  }
  const { rows: [row] } = await pool.query(`SELECT COUNT(*)::bigint AS retained,
    MIN(read_at) AS oldest,MAX(read_at) AS newest FROM energy_meter_readings WHERE company_id=$1`, [COMPANY]);
  result['facts-old'] = (await pool.query('SELECT COUNT(*)::bigint AS n FROM energy_counter_intervals WHERE company_id=$1 AND observed_at<$2', [COMPANY, cutoff])).rows[0].n;
  for(const [view,grain] of Object.entries(require('../src/lib/energy-refresh').VIEWS)) {
    const boundary = new Date(require('../src/lib/energy-refresh').floor(cutoff,grain));
    result[view+'-old'] = (await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${view} WHERE company_id=$1 AND bucket<$2`, [COMPANY,boundary])).rows[0].n;
  }
  return { ...result, ...row, complete: Object.values(result).every(n => BigInt(n) === 0n) };
}
async function execute(pool, o, log = console.log) {
  if (!o.apply) {
    const { rows: [row] } = await pool.query(`SELECT current_database() AS database,now() AS as_of,
      now()-interval '5 days' AS cutoff,(SELECT company_name FROM companies WHERE id=$1) AS company`, [COMPANY]);
    return { dry_run: true, company_id: COMPANY, ...row };
  }
  const target=(await pool.query('SELECT company_name FROM companies WHERE id=$1',[COMPANY])).rows[0];
  if(!target || target.company_name.replace(/[^a-z]/gi,'').toUpperCase()!=='SANDT')throw Error('Company 4 must be S AND T');
  fs.mkdirSync(o.backupDir, { recursive: true, mode: 0o700 }); fs.chmodSync(o.backupDir, 0o700);
  const file = path.join(o.backupDir, 'manifest.json');
  const { rows: [clock] } = await pool.query(`SELECT current_database() AS database,inet_server_addr()::text AS server_address,
    inet_server_port() AS server_port,now() AS as_of,now()-interval '5 days' AS cutoff`);
  const loadManifest=()=>{
    const m=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8'))
      :{company_id:COMPANY,days:5,database:clock.database,as_of:clock.as_of,cutoff:clock.cutoff,backups:[],completed:[]};
    if(m.company_id!==COMPANY||m.days!==5||m.database!==clock.database
      ||(m.server_address&&m.server_address!==clock.server_address)
      ||(m.server_port&&m.server_port!==clock.server_port))throw Error('Manifest target mismatch');
    m.server_address=clock.server_address;m.server_port=clock.server_port;return m;
  };
  if(o.stage==='verify') {
    if(!fs.existsSync(file))throw Error('Verified cleanup manifest is required');
    return verify(pool,loadManifest().cutoff);
  }
  const client = await pool.connect(); let locked = false; let jobs = [];let manifest=null;
  try {
    const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(hashtext('energy-maintenance:4')) AS ok");
    if (!lock.ok) throw Error('Company energy maintenance already running');
    locked = true;
    // Read/save checkpoints only while owning the maintenance lock. A second
    // invocation must neither overwrite progress nor resume the owner's jobs.
    manifest=loadManifest();save(o.backupDir,manifest);
    if (o.stage === 'cleanup') {
      // Versioned migration changes schema/guards only; it never enables or deletes history.
      const code = await require('./migrate').run(pool, { args: ['--through', '070_energy_quality_retention.sql'] });
      if (code) throw Error('Migration failed');
      await client.query(`INSERT INTO energy_history_policy(company_id,retention_days,enabled,maintenance,retained_from)
        VALUES($1,5,true,true,$2) ON CONFLICT(company_id) DO UPDATE SET retention_days=5,
        enabled=true,maintenance=true,retained_from=EXCLUDED.retained_from,updated_at=NOW()`, [COMPANY, manifest.cutoff]);
      await client.query(`INSERT INTO energy_pipeline_state(company_id,ready) VALUES($1,false)
        ON CONFLICT(company_id) DO UPDATE SET ready=false,updated_at=NOW()`, [COMPANY]);
      await client.query("SELECT pg_advisory_lock(hashtext('cron:energy-reconcile'))");
      const { rows: extension } = await client.query("SELECT 1 FROM pg_extension WHERE extname='timescaledb'");
      if (extension.length) {
        jobs = (await client.query(`SELECT job_id,scheduled FROM timescaledb_information.jobs
          WHERE hypertable_name IN('energy_meter_readings','energy_counter_intervals') OR
          hypertable_name IN(SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates
            WHERE view_schema='public' AND view_name IN('energy_counter_hourly','energy_counter_daily','energy_counter_monthly','energy_electrical_1m'))`)).rows;
        manifest.jobs ||= jobs; save(o.backupDir, manifest);
        for (const job of jobs.filter(j => j.scheduled)) await client.query('SELECT alter_job($1,scheduled=>false)', [job.job_id]);
      }
      if(!manifest.aggregate_from) {
        const earliest = [Date.parse(manifest.cutoff)];
        for(const view of Object.keys(require('../src/lib/energy-refresh').VIEWS)) {
          const row = (await client.query(`SELECT MIN(bucket) AS at FROM ${view} WHERE company_id=$1`, [COMPANY])).rows[0];
          if(row.at)earliest.push(new Date(row.at).getTime());
        }
        manifest.aggregate_from = new Date(Math.min(...earliest)).toISOString();save(o.backupDir,manifest);
      }
      // Public refreshes operate on whole time buckets. Do not refresh
      // another tenant's archived summaries as part of this initial purge.
      for(const [view,grain] of Object.entries(require('../src/lib/energy-refresh').VIEWS)) {
        const boundary=new Date(require('../src/lib/energy-refresh').floor(manifest.aggregate_from,grain));
        const other=await client.query(`SELECT 1 FROM ${view} WHERE company_id IS DISTINCT FROM $1 AND bucket>=$2 LIMIT 1`,[COMPANY,boundary]);
        if(other.rows.length)throw Error('Historical refresh requires isolation from other company energy summaries');
      }
      for (const op of operations()) {
        manifest.ranges ||= {};
        let range=manifest.ranges[op.name];
        // A committed historical window already certifies the original
        // minimum. Reuse it after an interrupted sweep rather than rescanning
        // every compressed CNC chunk. Guards prevent old energy reappearing.
        if(!range&&op.name==='raw-old') {
          const starts=manifest.completed.map(key=>/^raw-old:([^Z]+Z):/.exec(key)?.[1]).filter(Boolean).sort();
          if(starts.length)range={first:starts[0],last:new Date().toISOString()};
        }
        if(!range) {
          const result=await client.query(`SELECT MIN(${op.time}) AS first,MAX(${op.time}) AS last FROM ${op.table} WHERE company_id=$1 AND (${op.predicate})`, [COMPANY, manifest.cutoff]);
          range=result.rows[0];
        }
        manifest.ranges[op.name]=range;save(o.backupDir,manifest);
        if (!range.first) continue;
        const step=['energy_meter_readings','telemetry_raw'].includes(op.table)?3600e3:DAY;
        for (let from = Math.floor(new Date(range.first).getTime() / step) * step;
          from <= new Date(range.last).getTime(); from += step) {
          await mutate(client, o.backupDir, manifest, op, new Date(from).toISOString(), new Date(from + step).toISOString(), log);
        }
      }
      await clearDerived(client, o.backupDir, manifest);
      // Source deletion alone leaves Timescale materializations intact.
      // Refresh the ENTIRE removed history, including its original buckets.
      await rebuild.refresh(pool,{companyId:COMPANY,from:manifest.aggregate_from,to:new Date().toISOString(),decompress:true});
      manifest.cleanup = await verify(client, manifest.cutoff); save(o.backupDir, manifest);
      if (!manifest.cleanup.complete) throw Error('Cleanup verification incomplete');
      log({ stage: 'cleanup', ...manifest.cleanup });
      return manifest.cleanup;
    }
    if (!manifest.cleanup?.complete) throw Error('Run verified cleanup before rebuilding');
    const pf = await rebuild.preflight(pool, COMPANY);
    const from = new Date(Math.min(Date.parse(manifest.cutoff), pf.legacy_from ? new Date(pf.legacy_from).getTime() : Infinity,
      pf.meter_from ? new Date(pf.meter_from).getTime() : Infinity) - 1).toISOString();
    const to = new Date().toISOString();
    const ro = { companyId: COMPANY, apply: true, from, to, stepMinutes: 15, decompress: true, certifiedThrough: to };
    for (const stage of ['source', 'seed', 'drain', 'refresh', 'enable']) {
      const result = await rebuild.execute(pool, { ...ro, stage }, log);
      manifest[stage] = result; save(o.backupDir, manifest); log({ stage, result });
    }
    await client.query(`UPDATE energy_history_policy SET maintenance=false,last_swept_at=$2,updated_at=NOW() WHERE company_id=$1`, [COMPANY, manifest.cutoff]);
    return { ready: true, company_id: COMPANY, cutoff: manifest.cutoff };
  } finally {
    const unrestored=[];
    if(locked&&o.stage==='cleanup')for (const job of (manifest?.jobs || jobs).filter(j => j.scheduled)) {
      try {await client.query('SELECT alter_job($1,scheduled=>true)',[job.job_id]);}
      catch {unrestored.push(job.job_id);}
    }
    await client.query("SELECT pg_advisory_unlock(hashtext('cron:energy-reconcile'))").catch(() => {});
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('energy-maintenance:4'))").catch(() => {});
    client.release();
    if(unrestored.length)throw Error('Energy jobs require schedule recovery: '+unrestored.join(','));
  }
}
module.exports = { options, operations, backup, mutate, verify, execute };
if (require.main === module) {
  let o; try { o = options(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const env = require('dotenv').parse(fs.readFileSync(o.envFile));
  const pool = new Pool({ host: env.POSTGRESQL_HOST, port: Number(env.POSTGRESQL_PORT), user: env.POSTGRESQL_USER,
    password: env.POSTGRESQL_PASSWORD, database: env.POSTGRESQL_DATABASE, ssl: require('../src/config/database').sslOptions(env),
    max: 3, connectionTimeoutMillis: 5000, statement_timeout: 120000, application_name: 'energy-five-day-maintenance',
    ...(!o.apply ? { options: '-c default_transaction_read_only=on' } : {}) });
  execute(pool, o, item => console.log(JSON.stringify(item))).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.code || error.message); process.exitCode = 1; }).finally(() => pool.end());
}
