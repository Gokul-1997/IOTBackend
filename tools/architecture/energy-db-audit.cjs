#!/usr/bin/env node
'use strict';

/* Read-only evidence collector. No dotenv, customer row samples, schema edits,
 * refreshes, ANALYZE maintenance or extension installation. EXPLAIN ANALYZE is
 * opt-in, bounded to one machine and at most seven days of counter history.
 *
 * SCHEMA_AUDIT_URL=<private URL> node tools/architecture/energy-db-audit.cjs \
 *   --out /private/path/audit.json [--explain --company 4 --machine 19]
 *
 * collect(client), explainEnergy(client,options) require a connected client
 * outside any transaction; each establishes and rolls back READ ONLY itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const BACKEND = path.resolve(__dirname, '../..');
const TIMEOUT_MS = 15000;
const metadataSQL = {
  versions: `SELECT current_setting('server_version') AS postgres,extname,extversion FROM pg_extension ORDER BY extname`,
  tables: `SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
     c.reltuples::bigint AS estimated_rows,pg_total_relation_size(c.oid)::text AS parent_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname`,
  columns: `SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`,
  constraints: `SELECT conrelid::regclass::text AS table_name,conname,contype,convalidated,
    pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname`,
  indexes: `SELECT s.relname,s.indexrelname,s.idx_scan,s.idx_tup_read,s.idx_tup_fetch,
    pg_relation_size(s.indexrelid)::text AS bytes,pg_get_indexdef(s.indexrelid) AS definition
    FROM pg_stat_user_indexes s WHERE schemaname='public' ORDER BY s.relname,s.indexrelname`,
  invalid_indexes: `SELECT c.relname AS table_name,x.relname AS index_name,i.indisvalid,i.indisready
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class x ON x.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND (NOT i.indisvalid OR NOT i.indisready) ORDER BY c.relname,x.relname`,
  triggers: `SELECT event_object_table,trigger_name,action_timing,event_manipulation,action_statement
    FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY event_object_table,trigger_name`,
  functions: `SELECT p.oid::regprocedure::text AS signature,p.prokind,p.provolatile,p.prosecdef,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
        WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname`,
  views: `SELECT schemaname,viewname,definition FROM pg_views WHERE schemaname='public' ORDER BY viewname`,
  policies: `SELECT * FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`,
  table_stats: `SELECT relname,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_del,
    last_autovacuum,last_autoanalyze,seq_scan,idx_scan FROM pg_stat_user_tables
    WHERE schemaname='public' ORDER BY relname`,
  hypertables: `SELECT * FROM timescaledb_information.hypertables ORDER BY hypertable_schema,hypertable_name`,
  dimensions: `SELECT * FROM timescaledb_information.dimensions ORDER BY hypertable_schema,hypertable_name,dimension_number`,
  chunk_summary: `SELECT hypertable_schema,hypertable_name,COUNT(*) AS chunks,
    COUNT(*) FILTER(WHERE is_compressed) AS compressed,MIN(range_start) AS first_range_start,
    MAX(range_end) AS last_range_end FROM timescaledb_information.chunks
    GROUP BY hypertable_schema,hypertable_name ORDER BY hypertable_schema,hypertable_name`,
  hypertable_sizes: `SELECT h.hypertable_schema,h.hypertable_name,s.*
    FROM timescaledb_information.hypertables h
    CROSS JOIN LATERAL hypertable_detailed_size(format('%I.%I',h.hypertable_schema,h.hypertable_name)::regclass) s
    ORDER BY h.hypertable_schema,h.hypertable_name`,
  compression_sizes: `SELECT h.hypertable_schema,h.hypertable_name,s.*
    FROM timescaledb_information.hypertables h
    CROSS JOIN LATERAL hypertable_compression_stats(format('%I.%I',h.hypertable_schema,h.hypertable_name)::regclass) s
    WHERE h.compression_enabled ORDER BY h.hypertable_schema,h.hypertable_name`,
  compression_settings: `SELECT * FROM timescaledb_information.compression_settings`,
  continuous_aggregates: `SELECT * FROM timescaledb_information.continuous_aggregates ORDER BY view_schema,view_name`,
  jobs: `SELECT * FROM timescaledb_information.jobs ORDER BY job_id`,
  job_stats: `SELECT * FROM timescaledb_information.job_stats ORDER BY job_id`,
  statement_stats: `SELECT queryid,calls,total_exec_time,mean_exec_time,max_exec_time,rows,
    shared_blks_hit,shared_blks_read,temp_blks_read,temp_blks_written
    FROM public.pg_stat_statements ORDER BY total_exec_time DESC LIMIT 30`,
  migrations: `SELECT filename,checksum,applied_at FROM schema_migrations ORDER BY filename`
};

async function isolatedQuery(client, sql, values = []) {
  await client.query('SAVEPOINT energy_audit_query');
  const started = performance.now();
  try {
    const result = await client.query(sql, values);
    return { elapsed_ms: Math.round((performance.now() - started) * 100) / 100, rows: result.rows };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT energy_audit_query');
    return { elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      unavailable: error.code || error.name };
  } finally {
    await client.query('RELEASE SAVEPOINT energy_audit_query');
  }
}

async function readOnly(client, operation) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL lock_timeout = '3s'`);
    const check = await client.query('SHOW transaction_read_only');
    if (check.rows[0]?.transaction_read_only !== 'on') throw new Error('Read-only transaction required');
    return await operation();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function collect(client) {
  return readOnly(client, async () => {
    const evidence = {};
    for (const [name, sql] of Object.entries(metadataSQL)) evidence[name] = await isolatedQuery(client, sql);
    return { captured_at: new Date().toISOString(), access: 'READ ONLY; metadata only; no customer row samples', evidence };
  });
}

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('.') || entry.name === 'node_modules' ? [] : sourceFiles(file);
    return /\.(?:[cm]?js|ts)$/.test(entry.name) ? [file] : [];
  }).sort();
}

// Inventory intentionally reports dynamic SQL as dynamic/unknown. A lexical
// source inventory is evidence of call sites, not proof of tenant isolation.
function literalEnd(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue; }
    if (source[index] === quote) return index;
    if (quote === '`' && source[index] === '$' && source[index + 1] === '{') {
      let depth = 1;
      for (index += 2; index < source.length && depth; index++) {
        if (['\'', '"', '`'].includes(source[index])) {
          index = literalEnd(source, index);
          if (index < 0) return -1;
        } else if (source[index] === '/' && source[index + 1] === '/') {
          const newline = source.indexOf('\n', index + 2);
          index = newline < 0 ? source.length : newline;
        } else if (source[index] === '/' && source[index + 1] === '*') {
          const close = source.indexOf('*/', index + 2);
          if (close < 0) return -1;
          index = close + 1;
        } else if (source[index] === '{') depth++;
        else if (source[index] === '}') depth--;
      }
      if (depth) return -1;
      index--;
    }
  }
  return -1;
}

function sqlArgument(source, start) {
  let index = start;
  while (/\s/.test(source[index] || '') && index < source.length) index++;
  const quote = source[index];
  if (!['\'', '"', '`'].includes(quote)) return null;
  const end = literalEnd(source, index);
  return end < 0 ? null : source.slice(index + 1, end);
}

function queryInventory(root = BACKEND) {
  const entries = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    const calls = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)*query\s*\(/g;
    for (const match of source.matchAll(calls)) {
      const prefix = source.slice(0, match.index);
      const line = prefix.split('\n').length;
      const statement = sqlArgument(source, match.index + match[0].length);
      const normalized = statement?.replace(/\s+/g, ' ').trim() || null;
      const dynamic = normalized === null || normalized.includes('${');
      const relations = normalized ? [...new Set(Array.from(normalized.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z_0-9.]*)/gi), m => m[1]))].sort() : [];
      entries.push({ file: path.relative(root, file), line, call: match[0].replace(/\s+/g, ''),
        sql_fingerprint: normalized ? crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16) : null,
        dynamic, statement_kind: normalized?.match(/^(SELECT|WITH|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET)\b/i)?.[1]?.toUpperCase() || 'unknown',
        relations, mentions_tenant: normalized ? /\bcompany_id\b/i.test(normalized) : null,
        mentions_time_bound: normalized ? /\b(?:received_at|read_at|observed_at|hour_start|bucket|created_at|updated_at)\b\s*(?:>=?|<=?|BETWEEN)/i.test(normalized) : null });
    }
  }
  return { root: path.resolve(root), scanned_files: sourceFiles(path.join(root, 'src')).length,
    call_sites: entries.length, note: 'Lexical query-call inventory. Dynamic fragments, helpers and authorization require manual review; flags are not security findings.', entries };
}

function boundedId(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function latestMeterSQL(root) {
  const source = fs.readFileSync(path.join(root, 'src/dashboard/energy-meter.service.js'), 'utf8');
  const list = source.match(/const READING_COLUMNS\s*=\s*\[([\s\S]*?)\];/);
  const implementation = source.match(/function latestMeterFieldsSQL\([\s\S]*?\n}\n/);
  if (!list || !implementation) throw new Error('Latest meter SQL builder changed; update this audit adapter before running EXPLAIN');
  const columns = Array.from(list[1].matchAll(/'([a-z][a-z0-9_]*)'/g), match => match[1]);
  if (!columns.length) throw new Error('Meter columns unavailable');
  // Compile only the pure SQL builder; never load application db.js or .env.
  const build = vm.runInNewContext(`(${implementation[0]})`, {
    plantSql: () => '', READING_COLUMNS: columns, process: { env: {} },
    validSql: require(path.join(root, 'src/lib/energy-quality')).validSql
  }, { timeout: 100 });
  return build(columns, { legacyOnly: true });
}

function canonicalRawSQL(root) {
  const source = fs.readFileSync(path.join(root, 'src/dashboard/energy.service.js'), 'utf8');
  const match = source.match(/const DAILY_ENERGY_CTE\s*=\s*(`[^]*?`);/);
  if (!match) throw new Error('Canonical raw energy query changed; update this audit adapter before running EXPLAIN');
  const cte = vm.runInNewContext(match[1], { MAX_KW: 2000, MIN_WINDOW_SEC: 300 }, { timeout: 100 });
  return `WITH ${cte.replace('%MACHINE%', 'AND t.machine_id=$4')}
    SELECT machine_id,day,kwh,readings,rejected_intervals FROM daily ORDER BY day`;
}

async function explainEnergy(client, { companyId, machineId, lookbackDays = 30, periods = [1, 7], root = BACKEND, v2 = false } = {}) {
  const company = boundedId(companyId, 'companyId');
  const machine = boundedId(machineId, 'machineId');
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > 30) throw new Error('lookbackDays must be in (0,30]');
  if (!Array.isArray(periods) || !periods.length || periods.length > 2 || periods.some(days => !Number.isFinite(days) || days <= 0 || days > 7)) throw new Error('At most two counter ranges, each within seven days, are allowed');
  const latest = latestMeterSQL(root);
  const raw = canonicalRawSQL(root);
  return readOnly(client, async () => {
    const clock = (await client.query('SELECT CURRENT_TIMESTAMP AS at')).rows[0].at;
    const to = new Date(clock);
    const explain = sql => `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON,TIMING FALSE) ${sql}`;
    const result = { access: 'READ ONLY; SELECT plans executed with ANALYZE; 15s statement timeout',
      company_id: company, machine_id: machine, as_of: to.toISOString(), queries: {} };
    result.queries.latest_meter_30d = await isolatedQuery(client, explain(latest),
      [machine, new Date(to.getTime() - lookbackDays * 86400000), to, company]);
    for (const days of periods) {
      result.queries[`canonical_raw_${days}d`] = await isolatedQuery(client, explain(raw),
        [company, new Date(to.getTime() - days * 86400000), to, machine]);
    }
    if(v2) {
      result.queries.v2_latest_projection=await isolatedQuery(client,explain(`SELECT field_values,field_observed_at
        FROM energy_meter_latest WHERE company_id=$1 AND machine_id=$2`),[company,machine]);
      for(const days of periods)result.queries[`v2_hourly_${days}d`]=await isolatedQuery(client,explain(`SELECT bucket,register,shift_id,kwh,accepted_intervals,rejected_intervals,unallocated_intervals
        FROM energy_counter_hourly WHERE company_id=$1 AND machine_id=$4 AND register='kwh_total'
          AND bucket>=$2 AND bucket<$3 ORDER BY bucket`),[company,new Date(to.getTime()-days*86400000),to,machine]);
    }
    return result;
  });
}

function optionsOf(args) {
  const options = { out: null, explain: false, v2:false, companyId: null, machineId: null };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--out') options.out = args[++index];
    else if (args[index] === '--explain') options.explain = true;
    else if (args[index] === '--v2') {options.v2=true;options.explain=true;}
    else if (args[index] === '--company') options.companyId = args[++index];
    else if (args[index] === '--machine') options.machineId = args[++index];
    else throw new Error('Unknown audit option');
  }
  if (!options.out || !path.isAbsolute(options.out)) throw new Error('--out requires an absolute path to a new private JSON artifact');
  if (options.explain) { boundedId(options.companyId, 'companyId'); boundedId(options.machineId, 'machineId'); }
  return options;
}

async function main() {
  const options = optionsOf(process.argv.slice(2));
  if (!process.env.SCHEMA_AUDIT_URL) throw new Error('Set SCHEMA_AUDIT_URL explicitly; application environment is never loaded');
  if (fs.existsSync(options.out)) throw new Error('Audit artifact already exists; choose a new output path');
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.SCHEMA_AUDIT_URL,
    connectionTimeoutMillis: 5000, statement_timeout: TIMEOUT_MS,
    options: '-c default_transaction_read_only=on', application_name: 'iot-energy-db-audit-readonly' });
  try {
    await client.connect();
    const result = await collect(client);
    result.query_inventory = queryInventory();
    if (options.explain) result.explain = await explainEnergy(client, options);
    fs.mkdirSync(path.dirname(options.out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ artifact: options.out, query_call_sites: result.query_inventory.call_sites,
      unavailable: Object.entries(result.evidence).filter(([, value]) => value.unavailable).map(([key]) => key) }));
  } finally { await client.end(); }
}

module.exports = { collect, queryInventory, explainEnergy, optionsOf, latestMeterSQL, canonicalRawSQL };
if (require.main === module) main().catch(error => { console.error('Energy database audit failed:', error.code || error.name); process.exitCode = 1; });
