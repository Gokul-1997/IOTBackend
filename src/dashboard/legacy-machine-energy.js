const db = require('../db');

/* Keep the legacy counter calculation while rollout of the interval pipeline
 * remains disabled. The latest register used to sort a month of the broad
 * observation view after looking up sparse overrides for every CNC packet.
 * Read those override timestamps once, filter positive raw counters before
 * joining, and retain only each source's newest eligible measurement.
 *
 * A standalone value of zero or an invalid value still claims its timestamp:
 * it must not resurrect an older full-packet value from that same second.
 * The claim deliberately uses device_time directly, matching migration 063;
 * null device_time uses received_at for ordering but cannot claim a raw row.
 */
const SQL = `
      WITH readings AS (
        SELECT observed_at, energy,
               LAG(energy) OVER w AS prev_energy,
               LAG(observed_at) OVER w AS prev_at
          FROM energy_observations
         WHERE company_id = $4 AND machine_id = $1
           AND received_at >= $2::timestamptz - INTERVAL '5 minutes'
           AND received_at < $3::timestamptz + INTERVAL '5 minutes'
           AND received_at <= $5::timestamptz
           AND observed_at >= $2::timestamptz
           AND observed_at < $3::timestamptz
           AND observed_at <= $5::timestamptz
           AND energy > 0 AND energy < 'Infinity'::float8
        WINDOW w AS (ORDER BY observed_at, received_at)
      ), deltas AS (
        SELECT prev_energy IS NOT NULL AS has_previous,
               CASE
                 WHEN prev_energy IS NULL OR energy < prev_energy THEN NULL
                 WHEN energy - prev_energy <= (2000 * 300 / 3600.0)::float8 THEN energy - prev_energy
                 WHEN energy - prev_energy > 2000 * GREATEST(EXTRACT(EPOCH FROM observed_at - prev_at), 300) / 3600.0 THEN NULL
                 ELSE energy - prev_energy
               END AS delta
          FROM readings
      ), claimed AS MATERIALIZED (
        SELECT r.read_at
          FROM energy_meter_readings r
         WHERE r.company_id = $4 AND r.machine_id = $1
           AND r.standalone AND r.kwh_total IS NOT NULL
           AND r.read_at >= $5::timestamptz - INTERVAL '30 days'
           AND r.read_at <= $5::timestamptz
      ), source_latest AS (
        (SELECT t.energy, t.received_at,
                COALESCE(to_timestamp(t.device_time), t.received_at) AS observed_at
           FROM telemetry_raw t
          WHERE t.company_id = $4 AND t.machine_id = $1
            AND t.received_at >= $5::timestamptz - INTERVAL '30 days'
            AND t.received_at <= $5::timestamptz
            AND COALESCE(to_timestamp(t.device_time), t.received_at) >= $5::timestamptz - INTERVAL '30 days'
            AND COALESCE(to_timestamp(t.device_time), t.received_at) <= $5::timestamptz
            AND t.energy > 0 AND t.energy < 'Infinity'::float8
            AND NOT EXISTS (
              SELECT 1 FROM claimed r WHERE r.read_at = to_timestamp(t.device_time)
            )
          ORDER BY observed_at DESC, t.received_at DESC LIMIT 1)
        UNION ALL
        (SELECT r.kwh_total AS energy, r.read_at AS received_at, r.read_at AS observed_at
           FROM energy_meter_readings r
          WHERE r.company_id = $4 AND r.machine_id = $1 AND r.standalone
            AND r.read_at >= $5::timestamptz - INTERVAL '30 days'
            AND r.read_at <= $5::timestamptz
            AND r.kwh_total > 0 AND r.kwh_total < 'Infinity'::float8
          ORDER BY r.read_at DESC LIMIT 1)
      )
      SELECT SUM(delta) AS shift_kwh,
             COUNT(delta)::bigint AS accepted_intervals,
             COUNT(*) FILTER (WHERE has_previous AND delta IS NULL)::bigint AS rejected_intervals,
             (SELECT energy FROM source_latest
               ORDER BY observed_at DESC, received_at DESC LIMIT 1) AS total_energy
        FROM deltas
`;

async function getLegacyMachineEnergy({ companyId, machineId, start, end, asOf }) {
  const { rows } = await db.query(SQL, [machineId, start, end, companyId, asOf]);
  return rows[0] || {};
}

module.exports = { SQL, getLegacyMachineEnergy };
