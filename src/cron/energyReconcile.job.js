'use strict';
const { step } = require('../lib/energy-counter');
const REGISTERS = ['kwh_total', 'kwh_import', 'kwh_export', 'kvarh_total', 'kvah_total'];
const MAX_POINTS = 2000;
const IST_OFFSET = 330 * 60000;
const COLUMNS = ['company_id','machine_id','register','observed_at','interval_start','raw_value','delta',
  'quality','allocated','shift_id','measured_seconds','baseline_value','baseline_at','uncertain',
  'epoch_at','rule_id','event_id','state'];

function shiftFor(shifts, at) {
  const date = new Date(at.getTime() + IST_OFFSET);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds()/60;
  const minutes = t => { const [h,m,s=0] = t.split(':').map(Number); return h*60+m+s/60; };
  const found = shifts.filter(s => {
    const from=minutes(s.start_time), to=minutes(s.end_time);
    return from===to || (from<to ? minute>=from && minute<to : minute>=from || minute<to);
  });
  return found.length===1 ? found[0].id : null; // overlapping schedules are not guessed
}
function applicable(items, register, at, column) {
  return items.filter(row => row.register===register && new Date(row[column]).getTime()<=at)
    .at(-1);
}

async function writeFacts(client, facts) {
  for (let offset=0;offset<facts.length;offset+=1000) {
    const chunk=facts.slice(offset,offset+1000);
    const params=[];
    const tuples=chunk.map(row=>'('+COLUMNS.map((column,index)=>{
      const value=column==='state'?JSON.stringify(row[column]):row[column];
      params.push(value??null);
      return '$'+params.length+(column==='state'?'::jsonb':'');
    }).join(',')+')');
    await client.query(`INSERT INTO energy_counter_intervals(${COLUMNS.join(',')}) VALUES ${tuples.join(',')}
      ON CONFLICT(company_id,machine_id,register,observed_at) DO UPDATE SET
      ${COLUMNS.filter(c=>!['company_id','machine_id','register','observed_at','shift_id'].includes(c)).map(c=>`${c}=EXCLUDED.${c}`).join(',')},updated_at=NOW()`,params);
  }
}

/** Claim commits separately: a worker crash never loses its source range. */
async function claim(client, companyId, machineId) {
  const {rows}=await client.query(`UPDATE energy_reconcile_queue
    SET claimed_from=LEAST(claimed_from,from_at),from_at=NULL,attempts=attempts+1,last_error=NULL
    WHERE company_id=$1 AND machine_id=$2 RETURNING claimed_from`,[companyId,machineId]);
  return rows[0]?.claimed_from || null;
}

async function reconcileMachine(client,{companyId,machineId,from,maxPoints=MAX_POINTS}) {
  if (!Number.isInteger(maxPoints) || maxPoints<1 || maxPoints>10000) throw new RangeError('maxPoints must be between 1 and 10000');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    // The collector owns raw observations; only this worker owns validated
    // facts. Serializing a device does not block any other machine.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
      `energy-reconcile:${companyId}:${machineId}`]);
    const {rows:source}=await client.query(`SELECT read_at,read_at::text AS source_at,${REGISTERS.join(',')}
      FROM energy_meter_readings WHERE company_id=$1 AND machine_id=$2
        AND read_at >= $3 AND read_at <= NOW()
      ORDER BY read_at LIMIT $4`,[companyId,machineId,from,maxPoints+1]);
    const points=source.slice(0,maxPoints);
    // Use the first unread source timestamp, preserving PostgreSQL precision.
    // Incrementing a JS Date can skip a later sub-millisecond observation.
    const resume=source.length>maxPoints ? (source[maxPoints].source_at||source[maxPoints].read_at) : null;
    const {rows:rules}=await client.query(`SELECT * FROM energy_meter_rules
      WHERE company_id=$1 AND machine_id=$2 ORDER BY effective_from,id`,[companyId,machineId]);
    const {rows:events}=await client.query(`SELECT *,event_type AS type FROM energy_counter_events
      WHERE company_id=$1 AND machine_id=$2 ORDER BY effective_at,id`,[companyId,machineId]);
    const {rows:shifts}=await client.query('SELECT id,start_time,end_time FROM shifts WHERE company_id=$1 AND is_active ORDER BY id',[companyId]);
    // A corrected sparse record can remove one register, or an operator can
    // remove a bad source row. Remove only those now-orphaned derived facts in
    // the processed range. Existing shift classifications survive a replay.
    await client.query(`DELETE FROM energy_counter_intervals f
      WHERE f.company_id=$1 AND f.machine_id=$2 AND f.observed_at >= $3
        AND ($4::timestamptz IS NULL OR f.observed_at<$4) AND f.observed_at<=NOW()
        AND NOT EXISTS(SELECT 1 FROM energy_meter_readings r
          WHERE r.company_id=f.company_id AND r.machine_id=f.machine_id AND r.read_at=f.observed_at
            AND CASE f.register ${REGISTERS.map(register=>`WHEN '${register}' THEN r.${register}`).join(' ')} END IS NOT NULL)`,
    [companyId,machineId,from,resume]);
    const states=new Map();
    for(const register of REGISTERS) {
      const {rows:[prior]}=await client.query(`SELECT state FROM energy_counter_intervals
        WHERE company_id=$1 AND machine_id=$2 AND register=$3 AND observed_at<$4
        ORDER BY observed_at DESC LIMIT 1`,[companyId,machineId,register,from]);
      states.set(register,prior?.state||null);
    }
    const facts=[];
    for(const point of points) {
      const at=new Date(point.read_at), ms=at.getTime();
      for(const register of REGISTERS) {
        const value=point[register];
        if(value===null || value===undefined) continue; // omitted field is not an observation
        const previous=states.get(register);
        const configuredRule=applicable(rules,register,ms,'effective_from');
        const rule=configuredRule ? {...configuredRule,rule_id:configuredRule.id} : undefined;
        const event=applicable(events,register,ms,'effective_at');
        const result=step(previous,{value:Number(value),at,rule,event});
        states.set(register,result.state);
        const fact=result.fact;
        // Every reader uses measurement-end accounting, including normal
        // pairs crossing an hour/shift boundary. Do not invent fractions on
        // either side or call every healthy hour a missing-data interval.
        const allocated=fact.allocated;
        const delta=fact.delta;
        facts.push({company_id:companyId,machine_id:machineId,register,observed_at:point.source_at||at,
          interval_start:fact.interval_start,raw_value:Number.isFinite(Number(value))?Number(value):null,delta,
          quality:fact.quality,allocated,shift_id:shiftFor(shifts,at),
          measured_seconds:allocated?fact.measured_seconds:0,baseline_value:result.state.baseline_value,
          baseline_at:result.state.baseline_at==null?null:new Date(result.state.baseline_at),
          uncertain:result.state.uncertain,epoch_at:result.state.epoch_at==null?null:new Date(result.state.epoch_at),
          rule_id:result.state.rule_id,event_id:result.state.event_id,state:result.state});
      }
    }
    await writeFacts(client,facts);
    const through=points.length ? (points.at(-1).source_at||points.at(-1).read_at) : new Date();
    await client.query(`INSERT INTO energy_refresh_queue(company_id,machine_id,from_at,through_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(company_id,machine_id) DO UPDATE SET
      from_at=LEAST(energy_refresh_queue.from_at,EXCLUDED.from_at),
      through_at=GREATEST(energy_refresh_queue.through_at,EXCLUDED.through_at),
      updated_at=clock_timestamp(),last_error=NULL`,[companyId,machineId,from,through]);
    // Deleting the last source observation must also rewind its checkpoint.
    await client.query('DELETE FROM energy_counter_state WHERE company_id=$1 AND machine_id=$2',[companyId,machineId]);
    for(const [register,state] of states) if(state?.last_at!=null) {
      await client.query(`INSERT INTO energy_counter_state(company_id,machine_id,register,through_at,state)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(company_id,machine_id,register) DO UPDATE
        SET through_at=EXCLUDED.through_at,state=EXCLUDED.state,updated_at=NOW()`,
      [companyId,machineId,register,new Date(state.last_at),JSON.stringify(state)]);
    }
    // A late correction can affect a high-water baseline far beyond the
    // changed point. Replay forward in bounded pages, not only two neighbors.
    // Delete first: the queue CHECK deliberately forbids an empty work item.
    // An ingest arriving before this statement leaves from_at non-null; one
    // arriving after the deletion inserts a fresh work item.
    if(resume===null) await client.query(`DELETE FROM energy_reconcile_queue
      WHERE company_id=$1 AND machine_id=$2 AND from_at IS NULL`,[companyId,machineId]);
    await client.query(`UPDATE energy_reconcile_queue SET claimed_from=NULL,
      from_at=LEAST(from_at,$3::timestamptz),last_error=NULL,updated_at=NOW()
      WHERE company_id=$1 AND machine_id=$2`,[companyId,machineId,resume]);
    await client.query('COMMIT');
    return {points:points.length,facts:facts.length,more:resume!==null};
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    await client.query(`UPDATE energy_reconcile_queue SET last_error=$3,updated_at=NOW()
      WHERE company_id=$1 AND machine_id=$2`,[companyId,machineId,error.code||error.name]).catch(()=>{});
    throw error;
  }
}

async function run({pool=null,maxMachines=20,maxPoints=MAX_POINTS,companyId=null,touchCache=true,refreshAggregates=true,onlyReady=false,before=null}={}) {
  pool=pool||require('../db');
  if (!Number.isInteger(maxMachines) || maxMachines<1 || maxMachines>1000) throw new RangeError('maxMachines must be between 1 and 1000');
  if(before!==null&&!Number.isFinite(Date.parse(before)))throw new RangeError('before must be a valid timestamp');
  const client=await pool.connect();
  const summary={machines:0,points:0,facts:0,errors:[]};
  try {
    const {rows:[lock]}=await client.query("SELECT pg_try_advisory_lock(hashtext('cron:energy-reconcile')) AS ok");
    if(!lock.ok)return summary;
    try {
      const {rows:queue}=await client.query(`SELECT company_id,machine_id FROM energy_reconcile_queue
        WHERE ($1::int IS NULL OR company_id=$1) AND COALESCE(claimed_from,from_at)<=NOW()
        ${before===null?'':'AND LEAST(claimed_from,from_at)<$3::timestamptz'}
        ${onlyReady ? 'AND EXISTS(SELECT 1 FROM energy_pipeline_state s WHERE s.company_id=energy_reconcile_queue.company_id AND s.ready)' : ''}
        ORDER BY updated_at,company_id,machine_id LIMIT $2`,before===null?[companyId,maxMachines]:[companyId,maxMachines,before]);
      for(const item of queue) {
        try {
          const from=await claim(client,item.company_id,item.machine_id);
          if(!from)continue;
          const result=await reconcileMachine(client,{companyId:item.company_id,machineId:item.machine_id,from,maxPoints});
          summary.machines++;summary.points+=result.points;summary.facts+=result.facts;
          if(touchCache)require('../dashboard/cache').touch(item.company_id);
        }catch(error){summary.errors.push({company_id:item.company_id,machine_id:item.machine_id,code:error.code||error.name});}
      }
      const {rows:refresh}=refreshAggregates?await client.query(`SELECT company_id,machine_id FROM energy_refresh_queue
        WHERE ($1::int IS NULL OR company_id=$1) ${onlyReady ? 'AND EXISTS(SELECT 1 FROM energy_pipeline_state s WHERE s.company_id=energy_refresh_queue.company_id AND s.ready)' : ''} ORDER BY updated_at LIMIT $2`,[companyId,maxMachines])
        :{rows:[]};
      for(const item of refresh) {
        const result=await require('../lib/energy-refresh').refreshQueued(client,item.company_id,item.machine_id);
        if(result.error)summary.errors.push({...item,code:result.error,stage:'aggregate_refresh'});
      }
    } finally {await client.query("SELECT pg_advisory_unlock(hashtext('cron:energy-reconcile'))").catch(()=>{});}
  } finally {client.release();}
  return summary;
}
module.exports=async()=>{
  if(process.env.ENERGY_V2_ENABLED==='false')return;
  try {
    const result=await run({onlyReady:true});
    if(result.errors.length)console.error('[energy-reconcile] incomplete devices',JSON.stringify(result.errors));
  }catch(error){if(error.code!=='42P01')console.error('[energy-reconcile]',error.code||error.name);}
};
module.exports.run=run;
module.exports.reconcileMachine=reconcileMachine;
module.exports.shiftFor=shiftFor;
