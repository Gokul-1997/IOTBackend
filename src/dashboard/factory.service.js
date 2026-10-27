/*
 * Phase 2 · Screen 1 — Factory Overall Dashboard.
 *
 * One aggregate for the whole shop floor, filterable by shift, machine
 * and date. Everything here reads the rollup tables the MQTT processor
 * maintains (production_hourly) rather than scanning raw history.
 *
 * The existing dashboard.service covers the per-machine grid; this is
 * the factory-level view that sits above it.
 */
const db = require('../db');
const { plantSql, sharedEntityPlantSql } = require('../lib/read-scope');
const { severityClass } = require('./severity');
const { resolveWindow, parseMachineId } = require('./window');
const oeeSvc = require('./oee.dashboard.service');

/* Critical / Non-Critical / Information — one definition, see severity.js. */
const SEVERITY_CLASS = severityClass('severity');

/**
 * Resolve the reporting window.
 * Production uses the Production Report's shift START date. One bounded
 * set of recorded hourly rows feeds the headline, shift bars and trends;
 * a current component's multiplication factor must not rewrite old output.
 * Other dashboards keep their existing shared calendar-window behaviour.
 */
exports.getFactoryDashboard = async (req) => {
  const asOf       = new Date();
  const companyId  = req.user.company_id;
  const machineId  = parseMachineId(req.query.machine_id);
  const win        = await resolveWindow(companyId, req.query);

  const [
    settingsRes, machineRes, shiftRes, targetRes, yesterdayRes
  ] = await Promise.all([

    /* company tariff — cost is unavailable rather than zero when unset.
       The rate is the one set on Master → Energy Tariff (energy_settings,
       the company default), as the Energy screen uses; company_settings'
       older rate only when none is set there. Before, this read only
       company_settings, which the Tariff page never writes, so a tariff
       entered there priced the Energy screen but never this one. */
    db.query(
      `SELECT COALESCE(es.cost_per_kwh, NULLIF(cs.energy_rate_per_kwh, 0)) AS energy_rate_per_kwh,
              COALESCE(es.currency, cs.currency)                           AS currency,
              cs.oee_target_percent
         FROM (SELECT $1::int AS company_id) c
         LEFT JOIN company_settings cs ON cs.company_id = c.company_id
         LEFT JOIN energy_settings  es ON es.company_id = c.company_id AND es.machine_id IS NULL`, [companyId]
    ),

    /* live machine states: running / idle / breakdown / offline
     *
     * The LOOKBACK bound is load-bearing, not cosmetic. telemetry_raw is a
     * Timescale hypertable with ~180 chunks covering months of data; without
     * a received_at predicate the planner cannot prune chunks, so this
     * DISTINCT ON walks every chunk. Measured against production: unbounded
     * had not finished after 227 seconds, bounded returns in ~20ms.
     *
     * An hour is far more than the 60s freshness cut-off below, so it cannot
     * change which machines count as fresh — it only stops the scan reading
     * data that could never win the DISTINCT ON. Do not remove it.
     *
     * offline is derived rather than counted so the four states are mutually
     * exclusive and always sum to total. Counting it separately meant a
     * machine that was both stale and alarmed landed in breakdown AND
     * offline, and the numbers on the card did not add up. */
    db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (t.machine_id)
               t.machine_id, t.machine_status, t.alarm, t.received_at
        FROM telemetry_raw t
        JOIN machines m ON m.id = t.machine_id
        WHERE m.company_id = $1 AND m.is_active${plantSql('m.id')}
          AND t.received_at > NOW() - INTERVAL '1 hour'
          ${machineId ? 'AND t.machine_id = $2' : ''}
        ORDER BY t.machine_id, t.received_at DESC
      ),
      fresh AS (
        SELECT * FROM latest WHERE received_at > NOW() - INTERVAL '60 seconds'
      ),
      counted AS (
        SELECT
          COUNT(*) FILTER (WHERE alarm IS TRUE)::int AS breakdown,
          COUNT(*) FILTER (WHERE alarm IS NOT TRUE AND machine_status = 'RUNNING')::int AS running,
          COUNT(*) FILTER (WHERE alarm IS NOT TRUE AND machine_status = 'IDLE')::int    AS idle
        FROM fresh
      )
      SELECT
        tot.total,
        c.running,
        c.idle,
        c.breakdown,
        (tot.total - c.running - c.idle - c.breakdown)::int AS offline
      FROM counted c
      CROSS JOIN (
        SELECT COUNT(*)::int AS total FROM machines
        WHERE company_id = $1 AND is_active${plantSql('id')} ${machineId ? 'AND id = $2' : ''}
      ) tot`,
      machineId ? [companyId, machineId] : [companyId]
    ),

    /* Compare the shifts STARTING on the selected plant date, independently
       of the shift filter. A calendar-midnight bound put yesterday's night
       shift (00:00–08:00) under tonight's Shift 2 before it had even started.
       The coarse bounds keep the rollup scan bounded for chunk/index pruning;
       the per-shift bounds assign overnight output to its actual start date.
       Rollups start at the clock hour, including a shift starting at 08:30,
       so its first bucket overlaps rather than starts at the shift boundary.
       Do not admit upcoming shifts or future buckets, even if bad source data
       was preloaded. Keep zero rows through the LEFT JOIN for those shifts. */
    db.query(`
      SELECT sh.id AS shift_id, sh.shift_code, sh.shift_name, sh.start_time, sh.end_time,
             p.machine_id, p.hour_start,
             COALESCE(SUM(p.produced_qty),0)::int AS produced,
             COALESCE(SUM(p.run_seconds),0)::int AS run_seconds,
             COALESCE(SUM(p.idle_seconds),0)::int AS idle_seconds,
             COALESCE(SUM(p.energy_kwh),0)::float AS kwh
      FROM shifts sh
      LEFT JOIN production_hourly p
        ON p.shift_id = sh.id
       AND p.company_id = sh.company_id
       AND EXISTS (SELECT 1 FROM machines owned WHERE owned.id = p.machine_id AND owned.company_id = $1)
       AND p.hour_start >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 hour'
       AND p.hour_start < LEAST((($2::date + 2)::timestamp AT TIME ZONE 'Asia/Kolkata'), $3::timestamptz)
       AND p.hour_start + INTERVAL '1 hour' > ($2::date + sh.start_time) AT TIME ZONE 'Asia/Kolkata'
       AND p.hour_start < (
             CASE WHEN sh.start_time >= sh.end_time
                  THEN $2::date + INTERVAL '1 day' + sh.end_time
                  ELSE $2::date + sh.end_time
             END
           ) AT TIME ZONE 'Asia/Kolkata'
       AND ($2::date + sh.start_time) AT TIME ZONE 'Asia/Kolkata' <= $3::timestamptz${plantSql('p.machine_id')}
       ${machineId ? 'AND p.machine_id = $4' : ''}
      WHERE sh.company_id = $1 AND (sh.is_active OR p.hour_start IS NOT NULL)${sharedEntityPlantSql('sh')}
      GROUP BY sh.id, sh.shift_code, sh.shift_name, sh.start_time, sh.end_time, p.machine_id, p.hour_start
      UNION ALL
      /* Legacy/unassigned records have no shift start date. Include only
         their selected calendar day, never an unbounded history fallback. */
      SELECT NULL::int AS shift_id, 'Unassigned' AS shift_code, 'Unassigned' AS shift_name,
             NULL::time AS start_time, NULL::time AS end_time, p.machine_id, p.hour_start,
             COALESCE(SUM(p.produced_qty),0)::int AS produced,
             COALESCE(SUM(p.run_seconds),0)::int AS run_seconds,
             COALESCE(SUM(p.idle_seconds),0)::int AS idle_seconds,
             COALESCE(SUM(p.energy_kwh),0)::float AS kwh
      FROM production_hourly p
      JOIN machines owned ON owned.id = p.machine_id AND owned.company_id = $1
      LEFT JOIN shifts missing_shift ON missing_shift.id = p.shift_id AND missing_shift.company_id = p.company_id
      WHERE p.company_id = $1 AND missing_shift.id IS NULL${plantSql('p.machine_id')}
        AND p.hour_start >= $2::date::timestamp AT TIME ZONE 'Asia/Kolkata'
        AND p.hour_start < LEAST((($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), $3::timestamptz)
        ${machineId ? 'AND p.machine_id = $4' : ''}
      GROUP BY p.machine_id, p.hour_start
      ORDER BY shift_code, hour_start`,
      machineId
        ? [companyId, win.day, asOf.toISOString(), machineId]
        : [companyId, win.day, asOf.toISOString()]
    ),

    /* Each machine's target for a shift: the target quantity on its current
       job — the same figure the live dashboard measures a shift against. */
    db.query(`
      SELECT j.machine_id, j.target_qty::numeric AS target
        FROM machine_current_job j
        JOIN machines m ON m.id = j.machine_id AND m.company_id = $1 AND m.is_active
       WHERE j.is_active = TRUE${plantSql('j.machine_id')}
         ${machineId ? 'AND j.machine_id = $2' : ''}`,
      machineId ? [companyId, machineId] : [companyId]
    ),

    /* Yesterday uses the same shift-start-day attribution and recorded
       units as today, rather than comparing unlike calendar windows. */
    db.query(`
      SELECT p.machine_id,
             COALESCE(SUM(p.energy_kwh),0)::float AS kwh,
             COALESCE(SUM(p.produced_qty),0)::int AS produced
        FROM production_hourly p
        JOIN machines owned ON owned.id = p.machine_id AND owned.company_id = $1
        LEFT JOIN shifts sh ON sh.id = p.shift_id AND sh.company_id = p.company_id
       WHERE p.company_id = $1${plantSql('p.machine_id')}${sharedEntityPlantSql('sh')}
         AND p.hour_start >= (($2::date - 1)::timestamp AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 hour'
         AND p.hour_start < LEAST((($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'), $3::timestamptz)
         AND (
           (sh.id IS NULL
             AND p.hour_start >= ($2::date - 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
             AND p.hour_start < $2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
           OR (sh.id IS NOT NULL
             AND p.hour_start + INTERVAL '1 hour' > ($2::date - 1 + sh.start_time) AT TIME ZONE 'Asia/Kolkata'
             AND p.hour_start < (
               CASE WHEN sh.start_time >= sh.end_time
                    THEN $2::date - 1 + INTERVAL '1 day' + sh.end_time
                    ELSE $2::date - 1 + sh.end_time
               END
             ) AT TIME ZONE 'Asia/Kolkata'
             AND ($2::date - 1 + sh.start_time) AT TIME ZONE 'Asia/Kolkata' <= $3::timestamptz)
         )
         ${machineId ? 'AND p.machine_id = $4' : ''}
         ${win.shift ? `AND p.shift_id = $${machineId ? 5 : 4}` : ''}
       GROUP BY p.machine_id`,
      [companyId, win.day, asOf.toISOString(), ...(machineId ? [machineId] : []), ...(win.shift ? [win.shift.id] : [])]
    )
  ]);

  const settings   = settingsRes.rows[0] || {};
  const rate       = Number(settings.energy_rate_per_kwh || 0);
  const windowRows = shiftRes.rows.filter(r => r.hour_start && (!win.shift || r.shift_id === win.shift.id));
  const prod = windowRows.reduce((total, row) => ({
    produced: total.produced + Number(row.produced || 0),
    run_seconds: total.run_seconds + Number(row.run_seconds || 0),
    idle_seconds: total.idle_seconds + Number(row.idle_seconds || 0),
    energy_kwh: total.energy_kwh + Number(row.kwh || 0)
  }), { produced: 0, run_seconds: 0, idle_seconds: 0, energy_kwh: 0 });

  // Factory-local event/OEE bounds follow the shifts starting this date.
  // Shared resolveWindow still serves other analytics screens unchanged.
  const shiftWindows = new Map();
  for (const row of shiftRes.rows) {
    if (row.shift_id == null || shiftWindows.has(row.shift_id)) continue;
    const startsAt = new Date(`${win.day}T${row.start_time}+05:30`);
    const endsAt = new Date(`${win.day}T${row.end_time}+05:30`);
    if (endsAt <= startsAt) endsAt.setTime(endsAt.getTime() + 86_400_000);
    shiftWindows.set(row.shift_id, {
      starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
      status: asOf < startsAt ? 'upcoming' : asOf < endsAt ? 'in_progress' : 'completed'
    });
  }
  const eventWindows = win.shift ? [shiftWindows.get(win.shift.id)].filter(Boolean) : [...shiftWindows.values()];
  if (!win.shift && windowRows.some(row => row.shift_id == null)) eventWindows.push({
    starts_at: `${win.day}T00:00:00+05:30`,
    ends_at: new Date(Date.parse(`${win.day}T00:00:00+05:30`) + 86_400_000).toISOString()
  });
  const eventStart = eventWindows.length ? new Date(Math.min(...eventWindows.map(w => Date.parse(w.starts_at)))).toISOString() : win.from;
  const eventEnd = new Date(Math.max(Date.parse(eventStart), Math.min(asOf.getTime(), eventWindows.length ? Math.max(...eventWindows.map(w => Date.parse(w.ends_at))) : Date.parse(win.to)))).toISOString();
  const eventParams = machineId ? [companyId, eventStart, eventEnd, machineId] : [companyId, eventStart, eventEnd];
  const eventShift = win.shift ? `$${eventParams.push(win.shift.id)}` : null;

  /* month-to-date energy, for the monthly cost figure, and the same days
     of last month for the "vs last month" comparison */
  const monthRequest = db.query(`
    SELECT COALESCE(SUM(energy_kwh) FILTER (
             WHERE hour_start >= date_trunc('month', $2::date)
               AND hour_start <  (date_trunc('month', $2::date) + INTERVAL '1 month')), 0)::float AS kwh,
           COALESCE(SUM(energy_kwh) FILTER (
             WHERE hour_start >= date_trunc('month', $2::date) - INTERVAL '1 month'
               AND hour_start <  ($2::date - INTERVAL '1 month' + INTERVAL '1 day')), 0)::float AS prev_kwh
    FROM production_hourly
    WHERE company_id = $1${plantSql('machine_id')}
      AND hour_start >= date_trunc('month', $2::date) - INTERVAL '1 month'
      AND hour_start <  (date_trunc('month', $2::date) + INTERVAL '1 month')
      ${machineId ? 'AND machine_id = $3' : ''}`,
    machineId ? [companyId, win.day, machineId] : [companyId, win.day]
  );

  const [machineTotals, downtimeRes, alarmRes, monthRes] = await Promise.all([
    oeeSvc.machineTotals({ companyId, machineId, shiftId: win.shift?.id || null, start: eventStart, end: eventEnd }),
    db.query(`
      SELECT COALESCE(r.name,'Unclassified') AS reason,
             COALESCE(r.category,'UNPLANNED') AS category,
             COALESCE(SUM(d.duration_seconds),0)::int AS seconds,
             COUNT(*)::int AS events
      FROM downtime_events d
      LEFT JOIN downtime_reasons r ON r.id = d.downtime_reason_id
      WHERE d.company_id = $1${plantSql('d.machine_id')} AND d.started_at >= $2 AND d.started_at < $3
        ${machineId ? 'AND d.machine_id = $4' : ''}
        ${eventShift ? `AND d.shift_id = ${eventShift}` : ''}
      GROUP BY r.name, r.category ORDER BY seconds DESC`, eventParams),
    db.query(`
      SELECT ${SEVERITY_CLASS} AS class, COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE is_resolved IS NOT TRUE)::int AS open
      FROM machine_alarms
      WHERE company_id = $1${plantSql('machine_id')} AND started_at >= $2 AND started_at < $3
        ${machineId ? 'AND machine_id = $4' : ''}
        ${eventShift ? `AND shift_id = ${eventShift}` : ''}
      GROUP BY 1`, eventParams),
    monthRequest
  ]);

  /* Keep the existing OEE derivation/cycle/quality method, but its production
     inputs must be the exact same shift-day rows as the other factory tiles.
     This also preserves a partial first-hour bucket at a half-hour start. */
  const totalsByMachine = new Map();
  for (const row of windowRows) {
    const total = totalsByMachine.get(row.machine_id) || { produced: 0, run_seconds: 0, idle_seconds: 0, hours: 0 };
    total.produced += Number(row.produced || 0);
    total.run_seconds += Number(row.run_seconds || 0);
    total.idle_seconds += Number(row.idle_seconds || 0);
    total.hours += 1;
    totalsByMachine.set(row.machine_id, total);
  }
  const derived = machineTotals.map(row => oeeSvc.deriveOee({
    ...row, ...(totalsByMachine.get(row.machine_id) || { produced: 0, run_seconds: 0, idle_seconds: 0, hours: 0 })
  }, oeeSvc.DEFAULT_THRESHOLDS));
  const fleet = oeeSvc.fleetOee(derived, oeeSvc.DEFAULT_THRESHOLDS);

  /* ── targets ── */
  const targetOf = new Map(targetRes.rows.map(r => [r.machine_id, { target: Number(r.target) || 0 }]));
  const shiftTarget = [...targetOf.values()].reduce((a, t) => a + t.target, 0);
  const targetMachines = [...targetOf.entries()].filter(([, t]) => t.target > 0).map(([id]) => id);
  const targetMachineIds = new Set(targetMachines);

  /* One row per shift: all output, and the output of machines with a target
     set against the sum of those targets. */
  const shifts = new Map();
  for (const r of shiftRes.rows) {
    const e = shifts.get(r.shift_id) || {
      shift_id: r.shift_id, shift_code: r.shift_code, shift_name: r.shift_name,
      start_time: r.start_time, end_time: r.end_time, produced: 0, actual: 0,
      ...shiftWindows.get(r.shift_id)
    };
    e.produced += Number(r.produced || 0);
    if (targetMachineIds.has(r.machine_id)) e.actual += Number(r.produced || 0);
    shifts.set(r.shift_id, e);
  }
  const shiftwise = [...shifts.values()].map(e => ({ ...e, target: e.shift_id == null ? null : shiftTarget || null }));

  /* Headline actual, pieces and trend use the same stored quantities and
     start-date rows as Production Report. Current targets stay configurable. */
  const inScope = win.shift ? shiftwise.filter(r => r.shift_id === win.shift.id) : shiftwise;
  const actualInScope = windowRows.reduce((a, r) => a + (targetMachineIds.has(r.machine_id) ? Number(r.produced || 0) : 0), 0);
  const targetInScope = shiftTarget * inScope.filter(row => row.shift_id != null).length;

  /* Hourly trend: output in parts, and each hour's share of the targets —
     a shift's target spread evenly over its hours. */
  const shiftHours = new Map(shiftwise.map(r => {
    if (r.shift_id == null) return [null, null];
    const [sh, sm] = String(r.start_time).split(':').map(Number);
    const [eh, em] = String(r.end_time).split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;                       // overnight
    return [r.shift_id, mins / 60];
  }));
  /* Rows start on the hour and on the half hour (older rows were cut on
     IST hours, newer ones on UTC hours), so bucket by the IST clock hour —
     otherwise every hour is drawn twice. */
  const IST = 5.5 * 3600 * 1000, HOUR = 3600 * 1000;
  const byHour = new Map();
  for (const r of windowRows) {
    const t = new Date(r.hour_start).getTime();
    const bucket = new Date(Math.floor((t + IST) / HOUR) * HOUR - IST);
    const key = bucket.toISOString();
    const e = byHour.get(key) || { hour: bucket, kwh: 0, produced: 0, shift_id: r.shift_id };
    e.kwh += Number(r.kwh || 0);
    e.produced += Number(r.produced || 0);
    byHour.set(key, e);
  }
  const trend = [...byHour.values()].sort((a, b) => a.hour.getTime() - b.hour.getTime()).map(e => {
    const hrs = shiftHours.get(e.shift_id);
    return {
      hour: e.hour,
      kwh: Number(e.kwh.toFixed(3)),
      produced: e.produced,
      target: shiftTarget && hrs ? Math.round(shiftTarget / hrs) : null
    };
  });

  const producedParts = prod.produced;
  const yday = yesterdayRes.rows.reduce((a, r) => ({ kwh: a.kwh + Number(r.kwh || 0), produced: a.produced + Number(r.produced || 0) }),
                                         { kwh: 0, produced: 0 });
  const pctChange = (now, before) => (before > 0 ? Number((((now - before) / before) * 100).toFixed(1)) : null);
  const perPart = (kwh, produced) => (rate && produced > 0 ? Number(((kwh * rate) / produced).toFixed(2)) : null);

  const alarmBy = Object.fromEntries(alarmRes.rows.map(r => [r.class, r]));
  const dtRows  = downtimeRes.rows;
  const dtTotal = dtRows.reduce((a, r) => a + r.seconds, 0);

  return {
    filters: {
      date: win.day,
      shift_id: win.shift?.id || null,
      shift_code: win.shift?.shift_code || null,
      machine_id: machineId
    },
    updated_at: asOf.toISOString(),

    machines: machineRes.rows[0],

    production: {
      produced: producedParts,
      // against the job targets of the machines that have one; null when none do
      actual: actualInScope,
      target: targetInScope || null,
      target_pct: targetInScope > 0 ? Number(((actualInScope / targetInScope) * 100).toFixed(1)) : null,
      machines_with_target: targetMachines.length
    },

    time: {
      run_seconds:  prod.run_seconds,
      idle_seconds: prod.idle_seconds,
      down_seconds: dtTotal
    },

    // null, not 0, when a factor cannot be measured (no cycle time, nothing made)
    oee: {
      availability: fleet.availability_pct,
      performance:  fleet.performance_pct,
      quality:      fleet.quality_pct,
      oee:          fleet.oee_pct,
      target:       Number(settings.oee_target_percent || 85),
      machines_measurable: fleet.machines_measurable
    },

    energy: {
      kwh:        Number(prod.energy_kwh.toFixed(3)),
      month_kwh:  Number((monthRes.rows[0]?.kwh || 0).toFixed(3)),
      currency:   settings.currency || 'INR',
      rate_per_kwh: rate || null,
      // null, not 0, when no tariff is configured — a zero here would
      // read as "electricity is free" rather than "not set up yet"
      cost_day:   rate ? Number((prod.energy_kwh * rate).toFixed(2)) : null,
      cost_month: rate ? Number(((monthRes.rows[0]?.kwh || 0) * rate).toFixed(2)) : null,
      // comparisons, null when there is nothing to compare against
      day_vs_yesterday_pct:   pctChange(prod.energy_kwh, yday.kwh),
      month_vs_last_pct:      pctChange(monthRes.rows[0]?.kwh || 0, monthRes.rows[0]?.prev_kwh || 0),
      cost_per_part:          perPart(prod.energy_kwh, producedParts),
      cost_per_part_vs_yesterday_pct: pctChange(perPart(prod.energy_kwh, producedParts) || 0, perPart(yday.kwh, yday.produced) || 0)
    },

    shiftwise,

    downtime: {
      total_seconds:     dtTotal,
      planned_seconds:   dtRows.filter(r => r.category === 'PLANNED').reduce((a, r) => a + r.seconds, 0),
      unplanned_seconds: dtRows.filter(r => r.category !== 'PLANNED').reduce((a, r) => a + r.seconds, 0),
      by_reason:         dtRows
    },

    alarms: {
      total:        alarmRes.rows.reduce((a, r) => a + r.count, 0),
      critical:     alarmBy.CRITICAL?.count     || 0,
      non_critical: alarmBy.NON_CRITICAL?.count || 0,
      information:  alarmBy.INFORMATION?.count  || 0,
      open:         alarmRes.rows.reduce((a, r) => a + r.open, 0)
    },

    trend
  };
};
