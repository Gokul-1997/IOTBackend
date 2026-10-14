/* A bucket has a measurable ideal cycle only when one snapshotted job covers
 * its entire observed shift interval. Today's component edits are irrelevant.
 */
const rowsSQL = `WITH shift_window AS (
  SELECT ($4::date+start_time) AT TIME ZONE 'Asia/Kolkata' AS starts,
    (CASE WHEN start_time>=end_time THEN $4::date+INTERVAL '1 day'+end_time ELSE $4::date+end_time END) AT TIME ZONE 'Asia/Kolkata' AS ends
  FROM shifts WHERE id=$3 AND company_id=$1
)
SELECT ph.machine_id,ph.hour_start,ph.run_seconds,ph.idle_seconds,ph.produced_qty,
  EXTRACT(EPOCH FROM (LEAST(ph.hour_start+INTERVAL '1 hour',w.ends)-GREATEST(ph.hour_start,w.starts))) AS planned_seconds,
  history.cycle_time_seconds
FROM production_hourly ph CROSS JOIN shift_window w
JOIN machines m ON m.id=ph.machine_id AND m.company_id=$1
LEFT JOIN LATERAL (
  SELECT CASE WHEN COUNT(*)=1 AND MIN(j.started_at)<=GREATEST(ph.hour_start,w.starts)
    AND MAX(COALESCE(j.ended_at,'infinity'::timestamptz))>=LEAST(ph.hour_start+INTERVAL '1 hour',w.ends)
    THEN MAX(j.cycle_time_seconds) END AS cycle_time_seconds
  FROM machine_current_job j WHERE j.machine_id=ph.machine_id AND j.company_id=$1
    AND j.started_at<LEAST(ph.hour_start+INTERVAL '1 hour',w.ends)
    AND COALESCE(j.ended_at,'infinity'::timestamptz)>GREATEST(ph.hour_start,w.starts)
) history ON TRUE
WHERE ph.company_id=$1 AND ph.machine_id=ANY($2::int[]) AND ph.shift_id=$3
  AND ph.hour_start<w.ends AND ph.hour_start+INTERVAL '1 hour'>w.starts
ORDER BY ph.machine_id,ph.hour_start`;
const round = value => value == null ? null : +value.toFixed(2);
function metrics(rows, plannedSeconds, accepted) {
  const produced = rows.reduce((sum, row) => sum + Number(row.produced_qty || 0), 0);
  const run = rows.reduce((sum, row) => sum + Number(row.run_seconds || 0), 0);
  const baselineKnown = rows.length > 0 && rows.every(row => Number(row.cycle_time_seconds) > 0);
  const idealWork = rows.reduce((sum, row) => sum + Number(row.produced_qty || 0) * Number(row.cycle_time_seconds || 0), 0);
  const availability = plannedSeconds > 0 ? Math.min(100, run / plannedSeconds * 100) : 0;
  const performance = baselineKnown && run > 0 ? Math.min(100, idealWork / run * 100) : null;
  const quality = accepted != null && produced > 0 ? Math.min(100, Math.max(0, accepted) / produced * 100) : null;
  return { availability: round(availability), performance: round(performance), quality: round(quality),
    oee: performance == null || quality == null ? null : round(availability * performance * quality / 10000) };
}
module.exports = { rowsSQL, metrics };
