#!/usr/bin/env node
/**
 * Remove the double-counted run/idle time from production_hourly, and
 * recompute the OEE rollups built from it.
 *
 * What happened. Until pms-backend's journal build, two writers added the
 * same seconds to production_hourly:
 *   - the per-reading path, on IST hours (hh:00 IST = hh-1:30 UTC), and
 *   - runtime-flush.js, every 5 s, on UTC hours (hh:00 UTC), with run and
 *     idle seconds only — never parts, energy or manual time.
 * So every report summing run or idle time (OEE, Factory, Operators, Downtime,
 * shift OEE, lost-time ₹) showed 1.7–2.4× the time the telemetry shows.
 *
 * What this removes. Rows on a UTC hour (minute 0 in UTC) with no parts, no
 * energy and no manual time, for a machine that also has per-reading rows
 * within 90 minutes — i.e. the runtime flush's copy of time already counted.
 * Rows on UTC hours that carry parts (an older collector, March–April 2026)
 * are kept, and nothing before the last of them is touched: until then the
 * two collectors' rows are mixed and cannot be separated reliably.
 *
 *   node scripts/fix-hourly-double-count.js            report only (read-only)
 *   node scripts/fix-hourly-double-count.js --apply    back up, delete, recompute
 *   node scripts/fix-hourly-double-count.js --rollback put the backed-up rows back
 *
 * --apply keeps every row it deletes or overwrites in fix_20261006_* tables,
 * so --rollback restores exactly what was there. Run --apply only after the
 * new collector (no runtime-flush) is deployed — otherwise new copies appear.
 */
const pool = require('../src/db');
const { runShiftOee } = require('../src/cron/shiftOee.job');
const { runHourlyOee } = require('../src/cron/hourlyOee.job');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ROLLBACK = args.includes('--rollback');
const B = 'fix_20261006';

/* From the hour after the last UTC-hour row that carries parts (the older
   collector) — every row before that is left as it is. */
const FIX_FROM = `COALESCE((SELECT max(hour_start) + interval '1 hour' FROM production_hourly
   WHERE extract(minute FROM hour_start AT TIME ZONE 'UTC') = 0
     AND (COALESCE(produced_qty, 0) <> 0 OR COALESCE(energy_kwh, 0) <> 0 OR COALESCE(manual_seconds, 0) <> 0)), '-infinity')`;

const CANDIDATES = `
  FROM production_hourly p
 WHERE p.hour_start >= ${FIX_FROM}
   AND extract(minute FROM p.hour_start AT TIME ZONE 'UTC') = 0
   AND COALESCE(p.produced_qty, 0) = 0
   AND COALESCE(p.energy_kwh, 0) = 0
   AND COALESCE(p.manual_seconds, 0) = 0
   AND EXISTS (SELECT 1 FROM production_hourly q
                WHERE q.machine_id = p.machine_id
                  AND extract(minute FROM q.hour_start AT TIME ZONE 'UTC') = 30
                  AND q.hour_start BETWEEN p.hour_start - interval '90 minutes' AND p.hour_start + interval '90 minutes')`;

/* Run time per machine on recent days: the reports' figure against the one
   the telemetry itself gives (consecutive readings, gaps capped at 5 min). */
async function reconcile(label) {
  const { rows } = await pool.query(`
    WITH days AS (
      SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date - d AS day FROM generate_series(1, 3) d
    ), t AS (
      SELECT machine_id, machine_status, (received_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
             LEAST(EXTRACT(EPOCH FROM LEAD(received_at) OVER (PARTITION BY machine_id ORDER BY received_at) - received_at), 300) AS dt
        FROM telemetry_raw
       WHERE received_at >= ((SELECT min(day) FROM days)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND received_at <  ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    ), measured AS (
      SELECT day, sum(dt) FILTER (WHERE machine_status = 'RUNNING') AS run_s FROM t GROUP BY day
    ), counted AS (
      SELECT (hour_start AT TIME ZONE 'Asia/Kolkata')::date AS day, sum(run_seconds) AS run_s
        FROM production_hourly
       WHERE hour_start >= ((SELECT min(day) FROM days)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND hour_start <  ((now() AT TIME ZONE 'Asia/Kolkata')::date::timestamp AT TIME ZONE 'Asia/Kolkata')
       GROUP BY 1
    )
    SELECT d.day::text, round(m.run_s / 3600.0, 1) AS run_h_telemetry, round(c.run_s / 3600.0, 1) AS run_h_reports,
           round(c.run_s / NULLIF(m.run_s, 0), 2) AS ratio
      FROM days d LEFT JOIN measured m USING (day) LEFT JOIN counted c USING (day) ORDER BY 1`);
  console.log(`\n${label} — run hours, all machines, by IST day (ratio 1.00 = reports agree with telemetry):`);
  console.table(rows);
}

async function report() {
  const { rows: [r] } = await pool.query(`
    SELECT count(*)::int AS rows, min(hour_start)::text AS first, max(hour_start)::text AS last,
           round(sum(run_seconds) / 3600.0) AS run_hours, round(sum(idle_seconds) / 3600.0) AS idle_hours
    ${CANDIDATES}`);
  console.log('Double-counted rows (runtime flush copies):', r);
  return r;
}

async function apply() {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    // the rollup jobs must not run while their inputs change
    await client.query(`SELECT pg_advisory_lock(hashtext('cron:hourly-oee')), pg_advisory_lock(hashtext('cron:shift-oee'))`);
    await client.query('BEGIN');
    const { rows: [{ first }] } = await client.query(`SELECT min(hour_start) AS first ${CANDIDATES}`);
    if (!first) { await client.query('ROLLBACK'); console.log('Nothing to fix.'); return; }

    await client.query(`CREATE TABLE ${B}_production_hourly AS SELECT p.* ${CANDIDATES}`);
    await client.query(`CREATE TABLE ${B}_oee_hourly AS SELECT * FROM oee_hourly WHERE hour_start >= $1`, [first]);
    await client.query(`CREATE TABLE ${B}_oee_shift_summary AS SELECT * FROM oee_shift_summary WHERE shift_date >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date - 1`, [first]);
    const del = await client.query(`
      DELETE FROM production_hourly p USING ${B}_production_hourly b
       WHERE p.machine_id = b.machine_id AND p.shift_id = b.shift_id AND p.hour_start = b.hour_start`);
    await client.query(`DELETE FROM oee_hourly WHERE hour_start >= $1`, [first]);
    await client.query(`DELETE FROM oee_shift_summary WHERE shift_date >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date - 1`, [first]);
    await client.query('COMMIT');
    console.log(`Deleted ${del.rowCount} double-counted rows from ${new Date(first).toISOString()} (kept in ${B}_production_hourly).`);

    // recompute the rollups from the corrected rows, hour by hour and shift by shift
    const fromMs = new Date(first).getTime() - 86_400_000;
    console.log('Recomputing shift OEE…');
    await runShiftOee({ fromMs, toMs: Date.now() });
    console.log('Recomputing hourly OEE…');
    const IST = 330 * 60_000;
    let h = Math.floor((new Date(first).getTime() + IST) / 3_600_000) * 3_600_000 - IST;
    const end = Date.now() - 3_600_000;
    let n = 0;
    for (; h <= end; h += 3_600_000) {
      await runHourlyOee(new Date(h));
      if (++n % 500 === 0) console.log(`  ${n} hours…`);
    }
    console.log(`Recomputed ${n} hours.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
    client.release();
  }
}

async function rollback() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO production_hourly SELECT * FROM ${B}_production_hourly ON CONFLICT DO NOTHING`);
    const { rows: [{ first }] } = await client.query(`SELECT min(hour_start) AS first FROM ${B}_production_hourly`);
    await client.query(`DELETE FROM oee_hourly WHERE hour_start >= $1`, [first]);
    await client.query(`INSERT INTO oee_hourly SELECT * FROM ${B}_oee_hourly ON CONFLICT DO NOTHING`);
    await client.query(`DELETE FROM oee_shift_summary WHERE shift_date >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date - 1`, [first]);
    await client.query(`INSERT INTO oee_shift_summary SELECT * FROM ${B}_oee_shift_summary ON CONFLICT DO NOTHING`);
    await client.query('COMMIT');
    console.log(`Restored the rows from ${B}_*. Drop those tables when no longer needed.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

(async () => {
  if (ROLLBACK) { await rollback(); await reconcile('After rollback'); return; }
  await report();
  await reconcile(APPLY ? 'Before' : 'Now');
  if (!APPLY) { console.log('\nRead-only. Run with --apply to fix (after the new collector is deployed).'); return; }
  await apply();
  await reconcile('After');
})()
  .then(() => pool.end())
  .catch(async err => { console.error(err); await pool.end(); process.exit(1); });
