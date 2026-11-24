#!/usr/bin/env node
'use strict';
const { Client } = require('pg');

async function backfill(client, { companyId, machineId, from, to, apply = false, transaction = true }) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(machineId) || machineId <= 0) throw Error('Explicit company and machine IDs are required');
  const start = new Date(from), end = new Date(to);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start || end - start > 7 * 86400000) throw Error('Choose an explicit source window of at most seven days');
  if (apply && transaction) await client.query('BEGIN');
  try {
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('controller-downtime:'||$1::text||':'||$2::text,0))", [companyId,machineId]);
    const { rows } = await client.query(`SELECT company_id,machine_id,device_time,received_at,machine_status,controller_downtime_value
      FROM telemetry_raw WHERE company_id=$1 AND machine_id=$2 AND received_at>=$3 AND received_at<$4
        AND device_time IS NOT NULL ORDER BY device_time,received_at LIMIT 100001`,[companyId,machineId,start,end]);
    if (rows.length > 100000) throw Error('Source window exceeds 100000 observations; choose a smaller window');
    const result = { company_id:companyId,machine_id:machineId,from:start.toISOString(),to:end.toISOString(),readings:rows.length,applied:false };
    if (!apply || !rows.length) { if (apply && transaction) await client.query('ROLLBACK'); return result; }
    const observedStart = new Date(Number(rows[0].device_time)*1000);
    const observedEnd = new Date(Number(rows.at(-1).device_time)*1000+1);
    const crossing = await client.query(`SELECT id FROM downtime_events WHERE company_id=$1 AND machine_id=$2
      AND source='controller' AND (started_at<$3 OR started_at>=$4) LIMIT 1`,[companyId,machineId,observedStart,observedEnd]);
    if (crossing.rows.length) throw Error('Existing controller events extend outside this rebuild window; widen the window before replacing derived events');
    await client.query('DELETE FROM controller_downtime_state WHERE company_id=$1 AND machine_id=$2',[companyId,machineId]);
    await client.query("DELETE FROM downtime_events WHERE company_id=$1 AND machine_id=$2 AND source='controller'",[companyId,machineId]);
    const points = rows.map(row => ({ ...row,device_time:Number(row.device_time) }));
    await client.query(`SELECT controller_downtime_observe((p.value->>'company_id')::int,(p.value->>'machine_id')::int,
        to_timestamp((p.value->>'device_time')::float8),(p.value->>'received_at')::timestamptz,
        p.value->>'machine_status',(p.value->>'controller_downtime_value')::float8)
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS p(value,position)
      ORDER BY p.position`,[JSON.stringify(points)]);
    result.events = (await client.query(`SELECT r.code,r.name,COUNT(*)::int events,SUM(e.duration_seconds)::bigint seconds
      FROM downtime_events e JOIN downtime_reasons r ON r.id=e.downtime_reason_id
      WHERE e.company_id=$1 AND e.machine_id=$2 AND e.source='controller'
      GROUP BY r.code,r.name ORDER BY r.code`,[companyId,machineId])).rows;
    if (transaction) await client.query('COMMIT');
    return { ...result,applied:true };
  } catch(error) { if (apply && transaction) await client.query('ROLLBACK'); throw error; }
}
module.exports={backfill};
if(require.main===module){
  const args=process.argv.slice(2),take=flag=>{const at=args.indexOf(flag);return at<0?undefined:args[at+1];};
  if(!process.env.REASON_DATABASE_URL){console.error('Set REASON_DATABASE_URL explicitly; default is a read-only preview');process.exit(1);}
  const client=new Client({connectionString:process.env.REASON_DATABASE_URL,application_name:'controller-reason-backfill',statement_timeout:120000});
  client.connect().then(()=>backfill(client,{companyId:Number(take('--company-id')),machineId:Number(take('--machine-id')),
    from:take('--from'),to:take('--to'),apply:args.includes('--apply')})).then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>client.end());
}
