#!/usr/bin/env node
'use strict';
/* Explicit, resumable operations. Never loads a production .env implicitly.
 * See docs/ENERGY_DATABASE_REBUILD_2026-11-02.md before --apply on a server. */
const { Pool } = require('pg');
const REGISTERS = ['kwh_total','kwh_import','kwh_export','kvarh_total','kvah_total'];
const AGGREGATES = ['energy_counter_hourly','energy_counter_daily','energy_counter_monthly','energy_electrical_1m'];
const OFFSET=330*60000;
const DAY=86400e3;
const GOOD="('measured','flat','rollover')";
function floor(value,grain) {
  const ms=new Date(value).getTime(),date=new Date(ms+OFFSET);
  if(grain==='month')return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)-OFFSET;
  const width=grain==='day'?DAY:grain==='hour'?3600e3:60000;
  return Math.floor((ms+OFFSET)/width)*width-OFFSET;
}
function next(value,grain) {
  if(grain==='month') {const date=new Date(value+OFFSET);return Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)-OFFSET;}
  return value+(grain==='day'?DAY:grain==='hour'?3600e3:60000);
}
const GRAINS={energy_counter_hourly:'hour',energy_counter_daily:'day',energy_counter_monthly:'month',energy_electrical_1m:'minute'};
function closedRange(from,to,grain,includeStart=false) {
  const start=floor(from,grain),end=floor(to,grain);
  return {from:new Date(includeStart||start===new Date(from).getTime()?start:next(start,grain)),to:new Date(end)};
}
function options(args) {
  const out={apply:false,decompress:false,companyId:null,from:null,to:null,stepMinutes:15,stage:'preflight'};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==='--apply')out.apply=true;
    else if(key==='--decompress')out.decompress=true;
    else if(key==='--company-id')out.companyId=Number(args[++i]);
    else if(key==='--from')out.from=args[++i];
    else if(key==='--to')out.to=args[++i];
    else if(key==='--stage')out.stage=args[++i];
    else if(key==='--step-minutes')out.stepMinutes=Number(args[++i]);
    else throw Error('Unknown option: '+key);
  }
  if(!Number.isSafeInteger(out.companyId)||out.companyId<=0)throw Error('--company-id is required');
  if(!['preflight','source','seed','drain','refresh','verify','enable','disable'].includes(out.stage))throw Error('Invalid stage');
  if(!Number.isInteger(out.stepMinutes)||out.stepMinutes<1||out.stepMinutes>60)throw Error('--step-minutes must be 1..60');
  if(['source','refresh','verify','enable'].includes(out.stage)) {
    for(const k of ['from','to'])if(typeof out[k]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(out[k])||!Number.isFinite(Date.parse(out[k])))throw Error('--from and --to require ISO timestamps with a timezone');
    if(Date.parse(out.from)>=Date.parse(out.to)||Date.parse(out.to)>Date.now()+1000)throw Error('Invalid or future rebuild window');
  }
  return out;
}
async function preflight(pool,companyId) {
  const {rows:[row]}=await pool.query(`SELECT
    (SELECT version()) AS postgres,
    (SELECT extversion FROM pg_extension WHERE extname='timescaledb') AS timescaledb,
    (SELECT COUNT(*) FROM energy_meter_readings r LEFT JOIN machines m ON m.id=r.machine_id
      WHERE (r.company_id=$1 OR r.company_id IS NULL) AND (r.company_id IS NULL OR m.company_id IS DISTINCT FROM r.company_id))::int AS invalid_owners,
    (SELECT MIN(received_at) FROM telemetry_raw WHERE company_id=$1 AND (energy IS NOT NULL OR voltage IS NOT NULL OR current IS NOT NULL OR power IS NOT NULL)) AS legacy_from,
    (SELECT MIN(read_at) FROM energy_meter_readings WHERE company_id=$1) AS meter_from,
    (SELECT MAX(read_at) FROM energy_meter_readings WHERE company_id=$1) AS meter_through,
    (SELECT COUNT(*) FROM energy_reconcile_queue WHERE company_id=$1)::int AS queued_machines`,[companyId]);
  return row;
}
async function source(pool,o,log) {
  // A receipt-time predicate prunes raw hypertable chunks. A separate event
  // time is retained, so a delayed packet does not become a new current read.
  const width=o.stepMinutes*60000;
  let total=0;
  for(let start=Date.parse(o.from);start<Date.parse(o.to);start+=width) {
    const end=Math.min(start+width,Date.parse(o.to));
    const client=await pool.connect();
    let changed=0;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      const result=await client.query(`INSERT INTO energy_meter_readings
      (company_id,machine_id,read_at,kwh_total,v_ll_avg,i_avg,kw_total)
      SELECT company_id,machine_id,observed_at,energy,voltage,current,power FROM (
        SELECT
          t.company_id,t.machine_id,COALESCE(to_timestamp(t.device_time),t.received_at) AS observed_at,
          ${['energy','voltage','current','power'].map(field=>`(array_agg(t.${field} ORDER BY t.received_at DESC) FILTER(WHERE t.${field} IS NOT NULL))[1] AS ${field}`).join(',')}
        FROM telemetry_raw t JOIN machines m ON m.id=t.machine_id AND m.company_id=t.company_id
        WHERE t.company_id=$1 AND t.received_at>=$2 AND t.received_at<$3
          AND COALESCE(to_timestamp(t.device_time),t.received_at)<=NOW()
          AND (t.energy IS NOT NULL OR t.voltage IS NOT NULL OR t.current IS NOT NULL OR t.power IS NOT NULL)
        GROUP BY t.company_id,t.machine_id,COALESCE(to_timestamp(t.device_time),t.received_at)
      ) readings
      ON CONFLICT(machine_id,read_at) DO UPDATE SET
        kwh_total=COALESCE(energy_meter_readings.kwh_total,EXCLUDED.kwh_total),
        v_ll_avg=COALESCE(energy_meter_readings.v_ll_avg,EXCLUDED.v_ll_avg),
        i_avg=COALESCE(energy_meter_readings.i_avg,EXCLUDED.i_avg),
        kw_total=COALESCE(energy_meter_readings.kw_total,EXCLUDED.kw_total)
      WHERE energy_meter_readings.company_id=EXCLUDED.company_id AND (
        (energy_meter_readings.kwh_total IS NULL AND EXCLUDED.kwh_total IS NOT NULL) OR
        (energy_meter_readings.v_ll_avg IS NULL AND EXCLUDED.v_ll_avg IS NOT NULL) OR
        (energy_meter_readings.i_avg IS NULL AND EXCLUDED.i_avg IS NOT NULL) OR
        (energy_meter_readings.kw_total IS NULL AND EXCLUDED.kw_total IS NOT NULL))`,
    [o.companyId,new Date(start),new Date(end)]);
      changed=result.rowCount;
      await client.query(`INSERT INTO energy_backfill_windows(company_id,from_at,through_at)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[o.companyId,new Date(start),new Date(end)]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    total+=changed;
    log({stage:'source',through:new Date(end).toISOString(),changed,total});
    // Each bounded statement is restartable and idempotent. Yield between
    // windows so rebuilds do not monopolize the collector's connection pool.
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  return {changed:total};
}
async function seed(pool,companyId) {
  const {rows:columnRows}=await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='energy_meter_readings'
      AND (data_type IN('double precision','real') OR column_name='aux_interrupts') ORDER BY ordinal_position`);
  const columns=columnRows.map(r=>r.column_name);
  if(!columns.length||columns.some(c=>!/^\w+$/.test(c)))throw Error('Invalid meter schema');
  const {rows:devices}=await pool.query('SELECT id FROM machines WHERE company_id=$1 ORDER BY id',[companyId]);
  for(const {id} of devices) {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`energy-latest:${companyId}:${id}`]);
      const {rows:[clock]}=await client.query('SELECT CURRENT_TIMESTAMP AS at');
      const now=new Date(clock.at);
      const {rows:[snapshot]}=await client.query(`WITH latest_at AS MATERIALIZED(
        SELECT ${columns.map(c=>`MAX(read_at) FILTER(WHERE ${c} IS NOT NULL AND ABS(${c})<'Infinity'::float8) AS ${c}_at`).join(',')}
        FROM energy_meter_readings WHERE machine_id=$1 AND company_id=$4 AND read_at>=$2 AND read_at<=$3),
        fields AS(SELECT v.name,r.read_at,to_jsonb(r)->v.name AS value FROM latest_at
          CROSS JOIN LATERAL(VALUES ${columns.map(c=>`('${c}',latest_at.${c}_at)`).join(',')})v(name,at)
          JOIN energy_meter_readings r ON r.machine_id=$1 AND r.company_id=$4 AND r.read_at=v.at)
        SELECT MAX(read_at) AS read_at,jsonb_object_agg(name,value) AS field_values,
          jsonb_object_agg(name,EXTRACT(EPOCH FROM read_at)*1000) AS field_observed_at FROM fields HAVING COUNT(*)>0`,
        [id,new Date(0),now,companyId]);
      if(snapshot) {
        const {rows:[old]}=await client.query('SELECT * FROM energy_meter_latest WHERE company_id=$1 AND machine_id=$2 FOR UPDATE',[companyId,id]);
        const values={...(old?.field_values||{})}, times={...(old?.field_observed_at||{})};
        for(const key of Object.keys(times))if(!Number.isFinite(Number(times[key]))||Number(times[key])>now.getTime()) {
          delete values[key];delete times[key];
        }
        for(const [key,value] of Object.entries(snapshot.field_values||{}))if(Number(snapshot.field_observed_at[key])>=Number(times[key]??-Infinity)) {
          values[key]=value;times[key]=snapshot.field_observed_at[key];
        }
        await client.query(`INSERT INTO energy_meter_latest(company_id,machine_id,field_values,field_observed_at,last_observed_at)
          VALUES($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT(company_id,machine_id) DO UPDATE SET
          field_values=EXCLUDED.field_values,field_observed_at=EXCLUDED.field_observed_at,
          last_observed_at=EXCLUDED.last_observed_at,updated_at=NOW()`,
        [companyId,id,JSON.stringify(values),JSON.stringify(times),new Date(Math.max(...Object.values(times).map(Number)))]);
      }
      await client.query(`SELECT energy_enqueue($1,$2,MIN(read_at)) FROM energy_meter_readings
        WHERE company_id=$1 AND machine_id=$2 HAVING MIN(read_at) IS NOT NULL`,[companyId,id]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return {machines:devices.length};
}
async function refresh(pool,o) {
  const {rows:pending}=await pool.query(`SELECT company_id,machine_id,updated_at::text AS version
    FROM energy_refresh_queue WHERE company_id=$1 AND from_at>=$2 AND through_at<$3`,[o.companyId,new Date(o.from),new Date(o.to)]);
  const {rows}=await pool.query("SELECT 1 FROM pg_extension WHERE extname='timescaledb'");
  // Timescale refresh CALL must be top-level, not in BEGIN or a DO function.
  // Refresh closed calendar buckets only. A future materialization watermark
  // would hide new readings in the current month from real-time aggregation.
  const refreshed=[];
  for(const name of rows.length?AGGREGATES:[]) {
    const range=closedRange(o.from,o.to,GRAINS[name],true);
    if(range.from>=range.to)continue;
    const {rows:chunks}=await pool.query(`SELECT format('%I.%I',c.chunk_schema,c.chunk_name) AS chunk
      FROM timescaledb_information.continuous_aggregates a
      JOIN timescaledb_information.chunks c ON c.hypertable_schema=a.materialization_hypertable_schema
        AND c.hypertable_name=a.materialization_hypertable_name
      WHERE a.view_schema=current_schema() AND a.view_name=$1 AND c.is_compressed
        AND c.range_start<$3::timestamptz AND c.range_end>$2::timestamptz`,[name,range.from,range.to]);
    if(chunks.length&&!o.decompress)throw Error(`Refresh refused: ${name} intersects ${chunks.length} compressed chunks. Check free disk space and rerun with --decompress; original measurements are retained.`);
    const paused=[];
    try {
      if(chunks.length) {
        const {rows:jobs}=await pool.query(`SELECT j.job_id,j.scheduled
          FROM timescaledb_information.continuous_aggregates a
          JOIN timescaledb_information.jobs j ON j.hypertable_schema=a.materialization_hypertable_schema
            AND j.hypertable_name=a.materialization_hypertable_name
          WHERE a.view_schema=current_schema() AND a.view_name=$1 AND j.proc_name='policy_compression'`,[name]);
        for(const job of jobs.filter(job=>job.scheduled)) {
          await pool.query('SELECT alter_job($1,scheduled=>FALSE)',[job.job_id]);paused.push(job.job_id);
        }
        for(const chunk of chunks)await pool.query('SELECT decompress_chunk($1::regclass,if_compressed=>TRUE)',[chunk.chunk]);
      }
      await pool.query(`CALL refresh_continuous_aggregate('${name}',$1::timestamptz,$2::timestamptz)`,[range.from,range.to]);
      refreshed.push({name,from:range.from.toISOString(),to:range.to.toISOString(),decompressed_chunks:chunks.length});
    }finally {
      // Preserve the original storage layout after a historical repair.
      // Use the public API; internal compressed tables are never edited.
      try {
        if(o.decompress)for(const chunk of chunks)await pool.query('SELECT compress_chunk($1::regclass,if_not_compressed=>TRUE)',[chunk.chunk]);
      } finally {for(const jobId of paused)await pool.query('SELECT alter_job($1,scheduled=>TRUE)',[jobId]);}
    }
  }
  let cleared=0;
  for(const item of pending) {
    const result=await pool.query(`DELETE FROM energy_refresh_queue
      WHERE company_id=$1 AND machine_id=$2 AND updated_at=$3::timestamptz`,[item.company_id,item.machine_id,item.version]);
    cleared+=result.rowCount||0;
  }
  return {refreshed,cleared,...(!rows.length?{views:'ordinary PostgreSQL views; no refresh needed'}:{})};
}
const differs=(a,b)=>`CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN ${a} IS DISTINCT FROM ${b} ELSE ABS(${a}-${b})>1e-7*GREATEST(1,ABS(${a}),ABS(${b})) END`;
async function verifyAggregate(pool,o,name) {
  const grain=GRAINS[name],range=closedRange(o.from,o.to,grain);
  if(range.from>=range.to)return {complete:true,skipped:'No complete bucket in this window',mismatched_buckets:0};
  const bucket=`(date_trunc('${grain}',${name==='energy_electrical_1m'?'read_at':'observed_at'} AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
  let measured,keys=['machine_id','bucket'],fields;
  if(name==='energy_electrical_1m') {
    const metrics=['kw_total','kva_total','i_avg','v_ll_avg','v_ln_avg','pf_avg','frequency_hz'];
    const expressions=metrics.flatMap(metric=>['sum','count','min','max'].map(fn=>`${fn.toUpperCase()}(${fn==='sum'?metric+'::double precision':metric})::double precision AS ${metric}_${fn}`));
    expressions.push('COUNT(*)::double precision AS samples','MAX(ABS(kw_total)) AS kw_peak','MAX(GREATEST(i1,i2,i3)) AS i_max',
      'MIN(LEAST(v12,v23,v31)) AS v_ll_min','MAX(GREATEST(v12,v23,v31)) AS v_ll_max',
      'MIN(LEAST(v1n,v2n,v3n)) AS v_ln_min','MAX(GREATEST(v1n,v2n,v3n)) AS v_ln_max');
    fields=[...metrics.flatMap(metric=>['sum','count','min','max'].map(fn=>`${metric}_${fn}`)),
      'samples','kw_peak','i_max','v_ll_min','v_ll_max','v_ln_min','v_ln_max'];
    measured=`SELECT machine_id,${bucket} AS bucket,${expressions.join(',')}
      FROM energy_meter_readings WHERE company_id=$1 AND read_at>=$2 AND read_at<$3 GROUP BY 1,2`;
  }else {
    keys=['machine_id','bucket','register','shift_id'];
    fields=['kwh','accepted_intervals','rejected_intervals','unallocated_kwh','unallocated_intervals','measured_seconds'];
    measured=`SELECT machine_id,${bucket} AS bucket,register,shift_id,SUM(delta) AS kwh,
      COUNT(delta) AS accepted_intervals,COUNT(*) FILTER(WHERE quality NOT IN ${GOOD}) AS rejected_intervals,
      SUM(delta) FILTER(WHERE NOT allocated) AS unallocated_kwh,
      COUNT(delta) FILTER(WHERE NOT allocated) AS unallocated_intervals,SUM(measured_seconds) AS measured_seconds
      FROM energy_counter_intervals WHERE company_id=$1 AND observed_at>=$2 AND observed_at<$3 GROUP BY 1,2,3,4`;
  }
  const {rows:[result]}=await pool.query(`/* energy:verify:${name} */ WITH measured AS(${measured}),
    aggregate AS(SELECT * FROM ${name} WHERE company_id=$1 AND bucket>=$2 AND bucket<$3)
    SELECT COUNT(*)::bigint AS checked_buckets,COUNT(*) FILTER(WHERE m.machine_id IS NULL OR a.machine_id IS NULL
      OR ${fields.map(field=>`(${field==='samples'||field.endsWith('_count')||field.endsWith('_intervals')
    ? `m.${field} IS DISTINCT FROM a.${field}`:differs(`m.${field}`,`a.${field}`)})`).join(' OR ')})::bigint AS mismatched_buckets
    FROM measured m FULL JOIN aggregate a ON ${keys.map(key=>key==='shift_id'?'COALESCE(m.shift_id,0)=COALESCE(a.shift_id,0)':`m.${key}=a.${key}`).join(' AND ')}`,
  [o.companyId,range.from,range.to]);
  return {...result,from:range.from.toISOString(),to:range.to.toISOString(),complete:BigInt(result.mismatched_buckets)===0n};
}
async function verify(pool,o) {
  const {rows:[row]}=await pool.query(`WITH source_points AS (
      SELECT machine_id,read_at,register,value FROM energy_meter_readings r
      CROSS JOIN LATERAL(VALUES ${REGISTERS.map(r=>`('${r}',r.${r})`).join(',')}) v(register,value)
      WHERE company_id=$1 AND read_at>=$2 AND read_at<$3 AND value IS NOT NULL),
    fact_points AS(SELECT * FROM energy_counter_intervals WHERE company_id=$1 AND observed_at>=$2 AND observed_at<$3),
    source AS(SELECT COUNT(*)::bigint n FROM source_points),
    facts AS(SELECT COUNT(*)::bigint n,SUM(delta) FILTER(WHERE register='kwh_total') AS kwh FROM fact_points),
    bad_source AS(SELECT COUNT(*)::bigint n FROM source_points s LEFT JOIN fact_points f
      ON f.machine_id=s.machine_id AND f.observed_at=s.read_at AND f.register=s.register
      WHERE f.machine_id IS NULL OR f.raw_value IS DISTINCT FROM CASE WHEN ABS(s.value)<'Infinity'::float8 THEN s.value END),
    orphan AS(SELECT COUNT(*)::bigint n FROM fact_points f LEFT JOIN source_points s
      ON f.machine_id=s.machine_id AND f.observed_at=s.read_at AND f.register=s.register WHERE s.machine_id IS NULL)
    SELECT source.n AS source_registers,facts.n AS facts,orphan.n AS orphan_facts,bad_source.n AS mismatched_source_facts,facts.kwh,
      (SELECT COUNT(*)::int FROM energy_reconcile_queue WHERE company_id=$1 AND LEAST(from_at,claimed_from)<$3) AS queued,
      (SELECT COUNT(*)::int FROM energy_refresh_queue WHERE company_id=$1 AND from_at<$3 AND through_at>=$2) AS refresh_queued,
      (SELECT MIN(read_at) FROM energy_meter_readings WHERE company_id=$1) AS oldest_meter
      FROM source,facts,orphan,bad_source`,[o.companyId,new Date(o.from),new Date(o.to)]);
  row.aggregates={};
  for(const name of AGGREGATES)row.aggregates[name]=await verifyAggregate(pool,o,name);
  // Count parity alone cannot certify history outside the requested interval.
  // Cutover requires a complete source-history backfill, not a convenient day.
  row.complete=BigInt(row.source_registers)===BigInt(row.facts)&&BigInt(row.orphan_facts)===0n
    &&BigInt(row.mismatched_source_facts)===0n&&Number(row.queued)===0&&Number(row.refresh_queued)===0
    &&Object.values(row.aggregates).every(aggregate=>aggregate.complete);
  return row;
}
async function execute(pool,o,log=console.log) {
  if(o.stage==='preflight')return preflight(pool,o.companyId);
  if(!o.apply)return {dry_run:true,stage:o.stage,company_id:o.companyId,from:o.from,to:o.to};
  if(o.stage==='source')return source(pool,o,log);
  if(o.stage==='seed')return seed(pool,o.companyId);
  if(o.stage==='drain') {
    const {run}=require('../src/cron/energyReconcile.job');
    let pages=0;
    for(;;) {
      const result=await run({pool,companyId:o.companyId,maxMachines:10,maxPoints:2000,touchCache:false,refreshAggregates:false});
      log({stage:'drain',page:++pages,...result});
      if(result.errors.length)throw Error('Reconciliation failed; queue retained. Inspect last_error before retrying.');
      if(!result.machines) {
        const {rows:[left]}=await pool.query(`SELECT COUNT(*)::int AS remaining FROM energy_reconcile_queue
          WHERE company_id=$1 AND COALESCE(claimed_from,from_at)<=NOW()`,[o.companyId]);
        if(Number(left.remaining))throw Error('Reconciliation is busy in another worker; retry drain after it finishes. Pending work is retained.');
        return {pages,remaining:0};
      }
    }
  }
  if(o.stage==='refresh')return refresh(pool,o);
  if(o.stage==='verify')return verify(pool,o);
  if(o.stage==='enable') {
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const {rows:[clock]}=await client.query('SELECT CURRENT_TIMESTAMP AS as_of');
      const asOf=new Date(new Date(clock.as_of).getTime()+1);
      const through=o.certifiedThrough ? new Date(o.certifiedThrough) : asOf;
      if(!Number.isFinite(through.getTime())||through>asOf||through<=new Date(o.from))throw Error('Invalid certified cutover boundary');
      // A bounded recent tail proves that the live collector has captured
      // every supplied scalar after the certified historical receipt window.
      // Older tails must be backfilled first, rather than scanning months here.
      if(Date.parse(o.to)<asOf.getTime()-DAY)throw Error('Cutover refused: backfill --to must be within the last 24 hours');
      const result=await verify(client,{...o,to:through.toISOString()});
      const pf=await preflight(client,o.companyId);
      if(!result.complete||pf.invalid_owners||
        (pf.legacy_from&&Date.parse(o.from)>new Date(pf.legacy_from).getTime())||
        (pf.meter_from&&Date.parse(o.from)>new Date(pf.meter_from).getTime()))throw Error('Cutover refused: incomplete history, mismatched aggregates, invalid ownership or queued work');
      const {rows:[coverage]}=await client.query(`SELECT COALESCE(range_agg(tstzrange(from_at,through_at,'[)'))
        @> tstzrange($2::timestamptz,$3::timestamptz,'[)'),FALSE) AS complete
        FROM energy_backfill_windows WHERE company_id=$1`,[o.companyId,o.from,o.to]);
      if(!coverage.complete)throw Error('Cutover refused: source backfill has uncertified gaps');
      const {rows:[tail]}=await client.query(`/* energy:verify:live-tail */ SELECT COUNT(*)::bigint AS missing_scalar_rows
        FROM telemetry_raw t JOIN machines m ON m.id=t.machine_id AND m.company_id=t.company_id
        LEFT JOIN energy_meter_readings r ON r.company_id=t.company_id AND r.machine_id=t.machine_id
          AND r.read_at=COALESCE(to_timestamp(t.device_time),t.received_at)
        WHERE t.company_id=$1 AND t.received_at>=$2 AND t.received_at<$3
          AND COALESCE(to_timestamp(t.device_time),t.received_at)<$3
          AND (${[['energy','kwh_total'],['voltage','v_ll_avg'],['current','i_avg'],['power','kw_total']]
    .map(([source,target])=>`(t.${source} IS NOT NULL AND ABS(t.${source})<'Infinity'::float8 AND r.${target} IS NULL)`).join(' OR ')})`,
      [o.companyId,new Date(o.to),asOf]);
      if(BigInt(tail.missing_scalar_rows)!==0n)throw Error('Cutover refused: live collector has uncaptured scalar observations. Extend source backfill and drain before retrying.');
      await setReady(client,o.companyId,true,o.from,through);
      await client.query('COMMIT');
      return {company_id:o.companyId,ready:true,verified_through:through.toISOString(),verification:result,
        live_tail:tail,cache_action:'Restart API instances or invalidate the company dashboard cache before serving the new pipeline'};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  await setReady(pool,o.companyId,false,null,null);
  return {company_id:o.companyId,ready:false,
    cache_action:'Restart API instances or invalidate the company dashboard cache before serving legacy answers'};
}
async function setReady(client,companyId,ready,from,to) {
  await client.query(`INSERT INTO energy_pipeline_state(company_id,ready,backfilled_from,backfilled_through)
    VALUES($1,$2,$3,$4) ON CONFLICT(company_id) DO UPDATE SET ready=EXCLUDED.ready,
    backfilled_from=COALESCE(EXCLUDED.backfilled_from,energy_pipeline_state.backfilled_from),
    backfilled_through=COALESCE(EXCLUDED.backfilled_through,energy_pipeline_state.backfilled_through),updated_at=NOW()`,
  [companyId,ready,from,to]);
}
module.exports={options,execute,preflight,source,seed,refresh,verify,verifyAggregate,closedRange};
if(require.main===module) {
  let o;try{o=options(process.argv.slice(2));}catch(error){console.error(error.message);process.exit(1);}
  if(!process.env.ENERGY_DATABASE_URL){console.error('Set ENERGY_DATABASE_URL explicitly');process.exit(1);}
  const pool=new Pool({connectionString:process.env.ENERGY_DATABASE_URL,max:2,
    statement_timeout:60000,application_name:'energy-rebuild'});
  execute(pool,o,item=>console.log(JSON.stringify(item))).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(error.code||error.message);process.exitCode=1;}).finally(()=>pool.end());
}
