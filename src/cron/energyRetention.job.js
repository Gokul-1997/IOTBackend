'use strict';

const { floor, next, VIEWS } = require('../lib/energy-refresh');
const HOUR = 60 * 60 * 1000;

/**
 * A policy is deliberately inert until an explicit, verified initial cleanup
 * sets its watermark. Subsequent sweeps retire one receipt-hour at a time.
 * Source cleanup and refresh are restartable: the watermark only advances
 * after every affected continuous aggregate has successfully refreshed.
 */
async function sweep(client, policy) {
  const companyId = policy.company_id;
  const from = policy.from_at;
  const through = policy.through_at;
  const counts = {};
  let originalRefresh = new Map();
  let retentionRefresh = [];
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const { rows: [active] } = await client.query(`SELECT company_id FROM energy_history_policy
      WHERE company_id=$1 AND enabled AND NOT maintenance
        AND COALESCE(last_swept_at,retained_from)=$2::timestamptz FOR UPDATE`, [companyId, from]);
    if (!active) {
      await client.query('ROLLBACK');
      return { skipped: true };
    }
    // Per-row delete triggers would otherwise enqueue the same machine for
    // every retired sample. Invalidate each machine once below instead.
    await client.query("SET LOCAL iot.energy_retention_cleanup='on'");
    const queries = {
      meter: `DELETE FROM energy_meter_readings WHERE company_id=$1
        AND read_at >= $2::timestamptz AND read_at < $3::timestamptz`,
      facts: `DELETE FROM energy_counter_intervals WHERE company_id=$1
        AND observed_at >= $2::timestamptz AND observed_at < $3::timestamptz`,
      raw: `UPDATE telemetry_raw SET energy=NULL,voltage=NULL,current=NULL,power=NULL
        WHERE company_id=$1 AND received_at >= $2::timestamptz-INTERVAL '5 minutes'
          AND received_at < $3::timestamptz+INTERVAL '5 minutes'
          AND COALESCE(to_timestamp(device_time),received_at) < $3::timestamptz
          AND (energy IS NOT NULL OR voltage IS NOT NULL OR current IS NOT NULL OR power IS NOT NULL)`,
      hourly: `UPDATE production_hourly SET energy_kwh=0 WHERE company_id=$1
        AND hour_start >= $2::timestamptz-INTERVAL '1 hour'
        AND hour_start < $3::timestamptz AND energy_kwh<>0`,
      gaps: `UPDATE ingest_gaps SET unallocated_energy_kwh=NULL WHERE company_id=$1
        AND resumed_at >= $2::timestamptz AND resumed_at < $3::timestamptz
        AND unallocated_energy_kwh IS NOT NULL`,
      late: `UPDATE telemetry_late SET payload=energy_strip_payload(payload) WHERE company_id=$1
        AND payload IS NOT NULL
        AND COALESCE(to_timestamp(device_time),received_at) >= $2::timestamptz
        AND COALESCE(to_timestamp(device_time),received_at) < $3::timestamptz
        AND payload IS DISTINCT FROM energy_strip_payload(payload)`
    };
    for (const [name, sql] of Object.entries(queries)) {
      counts[name] = (await client.query(sql, [companyId, from, through])).rowCount;
    }
    // Serialize with the source AFTER trigger, so a new channel observation
    // arriving during a sweep is never erased by a stale JSON snapshot.
    const { rows: latest } = await client.query(`SELECT machine_id FROM energy_meter_latest
      WHERE company_id=$1 AND EXISTS(SELECT 1 FROM jsonb_each(field_observed_at) j
        WHERE (j.value::text)::double precision < EXTRACT(EPOCH FROM $2::timestamptz)*1000)
      ORDER BY machine_id`, [companyId, through]);
    for (const { machine_id: machineId } of latest) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`energy-latest:${companyId}:${machineId}`]);
      await client.query(`UPDATE energy_meter_latest l SET
        field_values=COALESCE((SELECT jsonb_object_agg(j.key,l.field_values->j.key)
          FROM jsonb_each(l.field_observed_at) j
          WHERE (j.value::text)::double precision >= EXTRACT(EPOCH FROM $3::timestamptz)*1000),'{}'),
        field_observed_at=COALESCE((SELECT jsonb_object_agg(j.key,j.value)
          FROM jsonb_each(l.field_observed_at) j
          WHERE (j.value::text)::double precision >= EXTRACT(EPOCH FROM $3::timestamptz)*1000),'{}'),updated_at=NOW()
        WHERE company_id=$1 AND machine_id=$2`, [companyId, machineId, through]);
    }
    await client.query("DELETE FROM energy_meter_latest WHERE company_id=$1 AND field_observed_at='{}'::jsonb", [companyId]);
    await client.query('DELETE FROM energy_counter_state WHERE company_id=$1 AND through_at<$2::timestamptz', [companyId, through]);
    await client.query(`UPDATE energy_reconcile_queue SET
      from_at=CASE WHEN from_at IS NULL THEN NULL ELSE GREATEST(from_at,$2::timestamptz) END,
      claimed_from=CASE WHEN claimed_from IS NULL THEN NULL ELSE GREATEST(claimed_from,$2::timestamptz) END,
      updated_at=NOW() WHERE company_id=$1`, [companyId, through]);
    await client.query('DELETE FROM energy_backfill_windows WHERE company_id=$1 AND through_at<=$2::timestamptz', [companyId, through]);
    // The deletion window must stay durably invalidated while top-level CALL
    // runs. Keep the pre-existing live work separately: leaving its union with
    // a five-day-old deletion would make every device rescan five days again.
    // Lock before taking the snapshot so an intervening writer cannot be
    // overwritten by the later restore.
    const { rows: previousRefresh } = await client.query(`SELECT machine_id,
      from_at::text AS from_at,through_at::text AS through_at,
      updated_at::text AS version,last_error FROM energy_refresh_queue
      WHERE company_id=$1 ORDER BY machine_id FOR UPDATE`, [companyId]);
    originalRefresh = new Map(previousRefresh.map(row => [row.machine_id, row]));
    const { rows: invalidated } = await client.query(`INSERT INTO energy_refresh_queue(company_id,machine_id,from_at,through_at,updated_at)
      SELECT company_id,id,$2::timestamptz,$3::timestamptz,clock_timestamp() FROM machines WHERE company_id=$1
      ON CONFLICT(company_id,machine_id) DO UPDATE SET
      from_at=LEAST(energy_refresh_queue.from_at,EXCLUDED.from_at),
      through_at=GREATEST(energy_refresh_queue.through_at,EXCLUDED.through_at),
      updated_at=clock_timestamp()
      RETURNING machine_id,updated_at::text AS retention_version`, [companyId, from, through]);
    retentionRefresh = invalidated;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  // Timescale's public refresh procedure must run outside the source DML
  // transaction. Historical compressed refresh errors leave the durable
  // invalidation and watermark unchanged for a safe retry after maintenance.
  const { rows: [extension] } = await client.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'");
  if (extension) {
    for (const [view, grain] of Object.entries(VIEWS)) {
      const start = floor(from, grain);
      const end = Math.min(next(floor(new Date(through).getTime() - 1, grain), grain),floor(Date.now(), grain));
      if (start >= end) continue; // The open month remains a real-time source tail.
      await client.query(`CALL refresh_continuous_aggregate('${view}',$1::timestamptz,$2::timestamptz)`, [new Date(start), new Date(end)]);
    }
  }
  await client.query('BEGIN');
  try {
    // Only remove OUR invalidation after refreshing it. Preserve both the
    // exact bounds/version of earlier live work and any writer that arrived
    // during CALL. A refresh failure never reaches this cleanup transaction.
    for (const item of retentionRefresh) {
      const original = originalRefresh.get(item.machine_id);
      if (original) {
        await client.query(`UPDATE energy_refresh_queue SET from_at=$3::timestamptz,
          through_at=$4::timestamptz,updated_at=$5::timestamptz,last_error=$6
          WHERE company_id=$1 AND machine_id=$2 AND updated_at=$7::timestamptz`,
        [companyId,item.machine_id,original.from_at,original.through_at,original.version,
          original.last_error,item.retention_version]);
      } else {
        await client.query(`DELETE FROM energy_refresh_queue WHERE company_id=$1
          AND machine_id=$2 AND updated_at=$3::timestamptz`,
        [companyId,item.machine_id,item.retention_version]);
      }
    }
    await client.query(`UPDATE energy_history_policy SET last_swept_at=$3::timestamptz,updated_at=NOW()
      WHERE company_id=$1 AND enabled AND NOT maintenance
        AND COALESCE(last_swept_at,retained_from)=$2::timestamptz`, [companyId, from, through]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return { company_id: companyId, from, through, counts };
}

async function run({ pool = null, maxPolicies = 10, windowMs = HOUR, touchCache = true } = {}) {
  if (!Number.isInteger(maxPolicies) || maxPolicies < 1 || maxPolicies > 100) throw new RangeError('maxPolicies must be between 1 and 100');
  if (!Number.isInteger(windowMs) || windowMs < 60000 || windowMs > HOUR) throw new RangeError('windowMs must be between one minute and one hour');
  pool = pool || require('../db');
  const client = await pool.connect();
  const summary = { policies: 0, sweeps: [], errors: [] };
  try {
    const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(hashtext('cron:energy-reconcile')) AS ok");
    if (!lock?.ok) return summary;
    try {
      const { rows: policies } = await client.query(`SELECT company_id,
        COALESCE(last_swept_at,retained_from)::text AS from_at,
        LEAST(COALESCE(last_swept_at,retained_from)+$2::bigint*INTERVAL '1 millisecond',
          energy_history_cutoff(company_id))::text AS through_at
        FROM energy_history_policy WHERE enabled AND NOT maintenance
          AND COALESCE(last_swept_at,retained_from) < energy_history_cutoff(company_id)
        ORDER BY COALESCE(last_swept_at,retained_from),company_id LIMIT $1`, [maxPolicies, windowMs]);
      for (const policy of policies) {
        try {
          const result = await sweep(client, policy);
          if (result.skipped) continue;
          summary.policies++;
          summary.sweeps.push(result);
          if (touchCache) require('../dashboard/cache').touch(policy.company_id);
        } catch (error) {
          summary.errors.push({ company_id: policy.company_id, code: error.code || error.name });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('cron:energy-reconcile'))").catch(() => {});
    }
  } finally {
    client.release();
  }
  return summary;
}

module.exports = async () => {
  try {
    const result = await run();
    if (result.errors.length) console.error('[energy-retention] incomplete policies', JSON.stringify(result.errors));
  } catch (error) {
    if (error.code !== '42P01') console.error('[energy-retention]', error.code || error.name);
  }
};
module.exports.run = run;
module.exports.sweep = sweep;
