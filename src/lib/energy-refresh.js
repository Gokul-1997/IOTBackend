'use strict';
const OFFSET=330*60000;
function floor(value,grain) {
  const ms=new Date(value).getTime(),d=new Date(ms+OFFSET);
  if(grain==='month')return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)-OFFSET;
  const width=grain==='day'?86400e3:grain==='hour'?3600e3:60000;
  return Math.floor((ms+OFFSET)/width)*width-OFFSET;
}
const VIEWS={energy_counter_hourly:'hour',energy_counter_daily:'day',energy_counter_monthly:'month',energy_electrical_1m:'minute'};
function next(value,grain) {
  if(grain==='month'){const d=new Date(value+OFFSET);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-OFFSET;}
  return value+(grain==='day'?86400e3:grain==='hour'?3600e3:60000);
}
async function refreshQueued(client,companyId,machineId) {
  const {rows:[item]}=await client.query(`SELECT *,updated_at::text AS version FROM energy_refresh_queue
    WHERE company_id=$1 AND machine_id=$2`,[companyId,machineId]);
  if(!item)return {refreshed:0};
  try {
    const {rows:[extension]}=await client.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'");
    let refreshed=0;
    if(extension)for(const [view,grain]of Object.entries(VIEWS)) {
      const from=floor(item.from_at,grain);
      // Never advance the watermark into the open month/day/hour. Its tail
      // remains real-time and must include subsequently arriving facts.
      const through=Math.min(next(floor(item.through_at,grain),grain),floor(Date.now(),grain));
      if(from>=through)continue;
      await client.query(`CALL refresh_continuous_aggregate('${view}',$1::timestamptz,$2::timestamptz)`,[new Date(from),new Date(through)]);
      refreshed++;
    }
    await client.query(`DELETE FROM energy_refresh_queue WHERE company_id=$1 AND machine_id=$2
      AND updated_at=$3::timestamptz`,[companyId,machineId,item.version||item.updated_at]);
    return {refreshed};
  }catch(error){
    await client.query('UPDATE energy_refresh_queue SET last_error=$3 WHERE company_id=$1 AND machine_id=$2',[companyId,machineId,error.code||error.name]);
    return {refreshed:0,error:error.code||error.name};
  }
}
module.exports={refreshQueued,floor,next,VIEWS};
