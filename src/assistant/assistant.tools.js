/*
 * What the assistant can look at: fixed, read-only functions — reports,
 * and since 22 Oct 2026 the rest of the company's MEXA too (the user: "not
 * only reports — all company support"): machines right now, alarms,
 * downtime, maintenance, energy, Program Transfer, and how to use MEXA.
 *
 * The model never writes SQL and never names a company. Each tool runs the
 * same server code as the screens (report.service, the dashboards'
 * services), for the signed-in person's company and plant (the request's
 * read scope), and only when that person may open the matching page — the
 * same role-and-company check the API uses. A tool the person may not use is
 * not offered at all. Nothing here writes to the database, and no person's
 * name leaves it.
 */
const db = require('../db');
const reports = require('../reports/report.service');
const oee = require('../dashboard/oee.dashboard.service');
const { denialForAny } = require('../middleware/access.middleware');
const readScope = require('../lib/read-scope');
const { plantSql, sharedEntityPlantSql } = readScope;
const { effectivePlantId } = require('../lib/plant-scope');
const { MAX_DIRECT_DAYS } = require('../reports/report.limits');
const alarmsSvc = require('../dashboard/alarm.service');
const downtimeSvc = require('../dashboard/downtime.service');
const energySvc = require('../dashboard/energy.service');
const ticketsSvc = require('../tickets/ticket.service');
const programsSvc = require('../programs/program.service');
const { helpFor } = require('./assistant.help');

/** Pages whose figures a tool shows; the person needs one of them. */
const ACCESS = {
  production: ['page:reports:view'],
  oee: ['page:reports:view', 'page:oee-reports:view', 'page:analytics-oee:view'],
  status: ['page:dashboard:view', 'page:analytics-factory:view', 'page:dashboard:live:view'],
  alarms: ['page:alarms:view', 'page:analytics-alarms:view'],
  downtime: ['page:downtime:view', 'page:analytics-downtime:view'],
  maintenance: ['page:maintenance:view'],
  energy: ['page:analytics-energy:view'],
  programs: ['page:programs:view']
};
/** Energy reads every meter reading of the period: a shorter longest period than the reports. */
const ENERGY_MAX_DAYS = 31;

/** A tool's input the person (or the model) got wrong: told to the model, which can ask the person. */
class ToolProblem extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

/* ── shared pieces ── */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function period(input, today, maxDays = MAX_DIRECT_DAYS) {
  const from = String(input.date_from || ''), to = String(input.date_to || '');
  for (const [v, name] of [[from, 'date_from'], [to, 'date_to']]) {
    const d = new Date(`${v}T00:00:00Z`);
    if (!ISO_DAY.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      throw new ToolProblem(`${name} must be a real date in YYYY-MM-DD form.`);
    }
  }
  if (to < from) throw new ToolProblem('date_to is before date_from.');
  if (from > today) throw new ToolProblem(`The period starts after today (${today}); there are no records yet.`);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > maxDays) throw new ToolProblem(`A period can be at most ${maxDays} days; this one is ${days}.`);
  return { from, to: to > today ? today : to, days };
}

const squash = s => String(s || '').toLowerCase().replace(/[\s\-_.]/g, '');

/** A name the person typed → one of the company's own, or a question back. */
function pick(list, wanted, what) {
  const w = squash(wanted);
  if (!w) return null;
  const exact = list.filter(x => x.keys.some(k => squash(k) === w));
  const found = exact.length ? exact : list.filter(x => x.keys.some(k => squash(k).includes(w)));
  if (found.length === 1) return found[0];
  if (!found.length) throw new ToolProblem(`No ${what} called "${String(wanted).slice(0, 60)}".`, { known: list.map(x => x.name).slice(0, 60) });
  throw new ToolProblem(`"${String(wanted).slice(0, 60)}" matches more than one ${what}.`, { candidates: found.map(x => x.name).slice(0, 20) });
}

async function machinesOf(user) {
  const { rows } = await db.query(
    `SELECT id, machine_serial_no FROM machines
      WHERE company_id = $1 AND is_active = TRUE${plantSql('id')}
      ORDER BY machine_serial_no`, [user.company_id]);
  return rows.map(r => ({ id: r.id, name: r.machine_serial_no, keys: [r.machine_serial_no] }));
}

async function shiftsOf(user) {
  const { rows } = await db.query(
    `SELECT id, shift_code, shift_name FROM shifts
      WHERE company_id = $1 AND is_active = TRUE${sharedEntityPlantSql('shifts')}
      ORDER BY start_time`, [user.company_id]);
  return rows.map(r => ({ id: r.id, name: r.shift_name || r.shift_code, code: r.shift_code, keys: [r.shift_code, r.shift_name].filter(Boolean) }));
}

async function filtersOf(user, input) {
  const machine = input.machine ? pick(await machinesOf(user), input.machine, 'machine') : null;
  const shift = input.shift ? pick(await shiftsOf(user), input.shift, 'shift') : null;
  return { machine, shift };
}

const query = params => Object.entries(params)
  .filter(([, v]) => v !== null && v !== undefined && v !== '')
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const hours = s => Math.round((Number(s) || 0) / 36) / 100;          // seconds → hours, 2 places
const minutes = s => Math.round((Number(s) || 0) / 60);
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const clip = (v, n = 120) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);
/** "22 Oct 2026, 2:05 pm" in the company's own time. */
const at = (v, tz) => (v ? new Intl.DateTimeFormat('en-IN', { timeZone: tz || 'Asia/Kolkata', day: 'numeric', month: 'short',
  year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(v)) : null);

/** The period input every dated tool takes. */
const PERIOD_INPUT = {
  date_from: { type: 'string', description: 'First day, YYYY-MM-DD (company time).' },
  date_to: { type: 'string', description: 'Last day, YYYY-MM-DD; the same as date_from for one day.' }
};
const NAMED_INPUT = {
  machine: { type: 'string', description: 'A machine name. Leave out for all machines.' },
  shift: { type: 'string', description: 'A shift name or code. Leave out for all shifts.' }
};
const dated = (props = NAMED_INPUT) => ({
  type: 'object', properties: { ...PERIOD_INPUT, ...props }, required: ['date_from', 'date_to'], additionalProperties: false
});

/* ── the tools ── */

const TOOLS = {
  machines_and_shifts: {
    access: null,
    definition: {
      name: 'machines_and_shifts',
      description: 'The names of this company\'s machines and shifts, to match what the person typed or to offer choices when asking a clarifying question.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    async run(user) {
      const [machines, shifts] = await Promise.all([machinesOf(user), shiftsOf(user)]);
      return { data: { machines: machines.map(m => m.name), shifts: shifts.map(s => (s.code && s.code !== s.name ? `${s.name} (${s.code})` : s.name)) } };
    }
  },

  production_report: {
    access: ACCESS.production,
    definition: {
      name: 'production_report',
      description: 'The Production report for a period (as on Reports → Production): parts made, run and idle hours, energy and efficiency, with totals by machine, by shift and by day. Optionally for one machine and/or one shift.',
      input_schema: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'First day, YYYY-MM-DD (company time).' },
          date_to: { type: 'string', description: 'Last day, YYYY-MM-DD; the same as date_from for one day.' },
          machine: { type: 'string', description: 'A machine name, as the person said it. Leave out for all machines.' },
          shift: { type: 'string', description: 'A shift name or code. Leave out for all shifts.' }
        },
        required: ['date_from', 'date_to'],
        additionalProperties: false
      }
    },
    async run(user, input, ctx) {
      const p = period(input, ctx.today);
      const { machine, shift } = await filtersOf(user, input);
      const { rows, summary } = await reports.productionData(user.company_id, p.from, p.to, machine?.id ?? null, shift?.id ?? null, null);
      const source = {
        report: 'Production report', period: { from: p.from, to: p.to },
        filters: { machine: machine?.name ?? null, shift: shift?.name ?? null },
        view: `/reports?${query({ tab: 'production', from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id })}`,
        download: ctx.can.reportsExport ? {
          path: '/reports/production',
          params: { format: 'xlsx', date_from: p.from, date_to: p.to, machine_id: machine?.id, shift_id: shift?.id },
          filename: `production_${p.from}_to_${p.to}.xlsx`
        } : null
      };
      if (!rows.length) return { data: { report: 'Production', period: source.period, filters: source.filters, records: 0 }, source };

      const group = key => {
        const m = new Map();
        for (const r of rows) {
          const k = key(r) || '--';
          const g = m.get(k) || { name: k, parts: 0, run_s: 0, idle_s: 0 };
          g.parts += Number(r.produced_qty) || 0; g.run_s += Number(r.run_seconds) || 0; g.idle_s += Number(r.idle_seconds) || 0;
          m.set(k, g);
        }
        return [...m.values()].map(g => ({ name: g.name, parts: g.parts, run_hours: hours(g.run_s), idle_hours: hours(g.idle_s) }));
      };
      const byMachine = group(r => r.machine).sort((a, b) => b.parts - a.parts);
      return {
        data: {
          report: 'Production', period: source.period, filters: source.filters, records: rows.length,
          totals: {
            parts: Number(summary.total_parts) || 0, run_hours: num(summary.run_hours),
            energy_kwh: num(summary.total_energy), efficiency_pct: num(summary.efficiency_pct),
            efficiency_means: 'run time ÷ (run + idle time)'
          },
          by_machine: byMachine.slice(0, 25), machines_listed: Math.min(25, byMachine.length), machines_total: byMachine.length,
          by_shift: group(r => r.shift),
          by_day: p.days <= 31 ? group(r => String(r.hour || '').slice(0, 6)).map(({ name, parts }) => ({ day: name, parts })) : undefined
        },
        source
      };
    }
  },

  oee_report: {
    access: ACCESS.oee,
    definition: {
      name: 'oee_report',
      description: 'OEE for a period, as the OEE Dashboard computes it: overall OEE, availability, performance and quality, parts made, good and rejected, and each machine\'s figures. Optionally for one machine and/or one shift. To compare two periods, call it once for each.',
      input_schema: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'First day, YYYY-MM-DD (company time).' },
          date_to: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
          machine: { type: 'string', description: 'A machine name. Leave out for all machines.' },
          shift: { type: 'string', description: 'A shift name or code. Leave out for all shifts.' }
        },
        required: ['date_from', 'date_to'],
        additionalProperties: false
      }
    },
    async run(user, input, ctx) {
      const p = period(input, ctx.today);
      const { machine, shift } = await filtersOf(user, input);
      const d = await oee.getOee({ company_id: user.company_id, from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id, page: 1, limit: 200 });
      const k = d.kpis || {};
      const viewOnDashboard = ctx.can.oeeDashboard;
      const source = {
        report: viewOnDashboard ? 'OEE Dashboard' : 'Shift OEE report', period: { from: p.from, to: p.to },
        filters: { machine: machine?.name ?? null, shift: shift?.name ?? null },
        view: viewOnDashboard
          ? `/oee-dashboard?${query({ from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id })}`
          : ctx.can.reports ? `/reports?${query({ tab: 'shift-oee', from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id })}` : null,
        download: ctx.can.oeeExport ? {
          path: '/dashboard/oee/export/xlsx',
          params: { from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id },
          filename: `oee_${p.from}_to_${p.to}.xlsx`
        } : null
      };
      const machines = (d.machines?.data || []).map(m => ({
        name: m.machine_serial_no, oee_pct: num(m.oee_pct), availability_pct: num(m.availability_pct),
        performance_pct: num(m.performance_pct), quality_pct: num(m.quality_pct), parts: Number(m.produced) || 0
      }));
      if (!machines.length || (!Number(k.produced) && !Number(k.run_seconds))) {
        return { data: { report: 'OEE', period: source.period, filters: source.filters, records: 0 }, source };
      }
      return {
        data: {
          report: 'OEE', period: source.period, filters: source.filters,
          overall: {
            oee_pct: num(k.oee_pct), availability_pct: num(k.availability_pct), performance_pct: num(k.performance_pct),
            quality_pct: num(k.quality_pct), parts: Number(k.produced) || 0, good: Number(k.good) || 0, rejected: Number(k.rejected) || 0,
            run_hours: hours(k.run_seconds), downtime_hours: hours(k.downtime_seconds),
            machines_with_oee: k.machines_measurable, machines_total: k.machines_total
          },
          note: k.oee_pct == null ? (d.coverage?.note || 'OEE needs a cycle time on the machine\'s current job.') : undefined,
          machines: machines.sort((a, b) => b.parts - a.parts).slice(0, 25)
        },
        source
      };
    }
  },

  machine_status: {
    access: ACCESS.status,
    definition: {
      name: 'machine_status',
      description: 'Every machine right now, as the Live Dashboard shows it: running, idle, in alarm (breakdown) or offline (no data for over a minute), with when each last sent data.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    async run(user, _input, ctx) {
      // the last hour only: the telemetry table is too large to read unbounded (factory.service.js)
      const { rows } = await db.query(`
        WITH latest AS (
          SELECT DISTINCT ON (t.machine_id) t.machine_id, t.machine_status, t.alarm, t.received_at
            FROM telemetry_raw t
            JOIN machines m ON m.id = t.machine_id
           WHERE m.company_id = $1 AND m.is_active${plantSql('m.id')}
             AND t.received_at > NOW() - INTERVAL '1 hour'
           ORDER BY t.machine_id, t.received_at DESC)
        SELECT m.machine_serial_no,
               CASE WHEN l.received_at IS NULL OR l.received_at <= NOW() - INTERVAL '60 seconds' THEN 'offline'
                    WHEN l.alarm IS TRUE THEN 'alarm'
                    WHEN l.machine_status = 'RUNNING' THEN 'running'
                    WHEN l.machine_status = 'IDLE' THEN 'idle'
                    ELSE 'unknown' END AS state,
               l.received_at
          FROM machines m
          LEFT JOIN latest l ON l.machine_id = m.id
         WHERE m.company_id = $1 AND m.is_active${plantSql('m.id')}
         ORDER BY m.machine_serial_no`, [user.company_id]);
      const counts = { running: 0, idle: 0, alarm: 0, offline: 0, unknown: 0 };
      for (const r of rows) counts[r.state] += 1;
      return {
        data: {
          as_of: at(new Date(), ctx.timezone), machines_total: rows.length, ...counts,
          machines: rows.slice(0, 60).map(r => ({ name: r.machine_serial_no, state: r.state,
            last_data: r.received_at ? at(r.received_at, ctx.timezone) : 'none in the last hour' }))
        },
        source: { report: 'Live Dashboard', period: null, filters: {}, view: ctx.can.liveDashboard ? '/dashboard' : null, download: null }
      };
    }
  },

  alarm_summary: {
    access: ACCESS.alarms,
    definition: {
      name: 'alarm_summary',
      description: 'Alarms for a period (as Dashboards → Alarms): how many, critical and still open, the longest, the machines with most alarms, and the alarms still open (up to 10). Optionally one machine and/or one shift.',
      input_schema: dated()
    },
    async run(user, input, ctx) {
      const p = period(input, ctx.today);
      const { machine, shift } = await filtersOf(user, input);
      const d = await alarmsSvc.getAlarms({ company_id: user.company_id, from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id,
                                            part: 'kpis,charts,table', show: 'open', limit: 10 });
      const k = d.kpis || {};
      const source = { report: 'Alarm Dashboard', period: { from: p.from, to: p.to }, filters: { machine: machine?.name ?? null, shift: shift?.name ?? null },
                       view: ctx.can.alarmDashboard ? `/alarm-report?${query({ from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id })}` : '/alarms',
                       download: null };
      if (!Number(k.total)) return { data: { report: 'Alarms', period: source.period, filters: source.filters, records: 0 }, source };
      return {
        data: {
          report: 'Alarms', period: source.period, filters: source.filters,
          totals: { alarms: k.total, critical: k.critical, other: k.normal, still_open: k.open,
                    longest_minutes: minutes(k.max_duration_seconds), average_minutes: minutes(k.avg_duration_seconds) },
          longest: k.longest ? { machine: k.longest.machine_serial_no, code: clip(k.longest.alarm_code, 40), message: clip(k.longest.message) } : null,
          top_machines: (d.by_machine || []).map(m => ({ name: m.machine_serial_no, alarms: m.total, critical: m.critical })),
          by_shift: (d.by_shift || []).map(s => ({ shift: s.shift_name, alarms: s.total, critical: s.critical })),
          open_now: (d.alarms?.data || []).map(a => ({ machine: a.machine_serial_no, code: clip(a.alarm_code, 40), severity: a.severity,
                                                       message: clip(a.message), since: at(a.started_at, ctx.timezone), minutes: minutes(a.duration_seconds) })),
          open_listed: Math.min(10, d.alarms?.total || 0), open_total: d.alarms?.total || 0
        },
        source
      };
    }
  },

  downtime_summary: {
    access: ACCESS.downtime,
    definition: {
      name: 'downtime_summary',
      description: 'Downtime for a period (as Dashboards → Downtime): recorded downtime by reason and category, run and idle time, availability, idle time with no reason recorded, and its cost at the machines\' hour rates. Optionally one machine and/or one shift.',
      input_schema: dated()
    },
    async run(user, input, ctx) {
      const p = period(input, ctx.today);
      const { machine, shift } = await filtersOf(user, input);
      const d = await downtimeSvc.getDowntime({ company_id: user.company_id, from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id, part: 'kpis,charts' });
      const k = d.kpis || {};
      const source = { report: 'Downtime Dashboard', period: { from: p.from, to: p.to }, filters: { machine: machine?.name ?? null, shift: shift?.name ?? null },
                       view: ctx.can.downtimeDashboard ? `/downtime-analysis?${query({ from: p.from, to: p.to, machine_id: machine?.id, shift_id: shift?.id })}` : '/downtime',
                       download: null };
      if (!Number(k.run_seconds) && !Number(k.idle_seconds) && !Number(k.downtime_events)) {
        return { data: { report: 'Downtime', period: source.period, filters: source.filters, records: 0 }, source };
      }
      return {
        data: {
          report: 'Downtime', period: source.period, filters: source.filters,
          totals: { recorded_downtime_hours: hours(k.total_downtime_seconds), events: k.downtime_events, still_open: k.open_events,
                    run_hours: hours(k.run_seconds), idle_hours: hours(k.idle_seconds), alarm_hours: hours(k.alarm_seconds),
                    availability_pct: num(k.availability_pct), idle_with_no_reason_hours: hours(k.unaccounted_seconds),
                    reason_coverage_pct: num(k.reason_coverage_pct), idle_cost: num(k.idle_cost), alarm_cost: num(k.alarm_cost) },
          by_reason: (d.by_reason || []).slice(0, 8).map(r => ({ reason: r.reason, category: r.category, events: r.events,
                                                                  hours: hours(r.seconds), share_pct: r.share_pct })),
          by_category: (d.by_category || []).map(c => ({ category: c.category, events: c.events, hours: hours(c.seconds) }))
        },
        source
      };
    }
  },

  maintenance_status: {
    access: ACCESS.maintenance,
    definition: {
      name: 'maintenance_status',
      description: 'Maintenance now (as the Maintenance page): open tickets by status and priority with the most urgent (up to 10), and maintenance schedules that are overdue or due in the next 14 days. Optionally one machine.',
      input_schema: { type: 'object', properties: { machine: NAMED_INPUT.machine }, additionalProperties: false }
    },
    async run(user, input, ctx) {
      const { machine } = await filtersOf(user, { machine: input.machine });
      const values = [user.company_id];
      const onMachine = alias => (machine ? (values.push(machine.id), ` AND ${alias}.machine_id = $${values.length}`) : '');
      const ticketScope = `t.company_id = $1${plantSql('t.machine_id')}`;
      const scheduleScope = `ms.company_id = $1${plantSql('ms.machine_id')}`;
      const ticketMachine = onMachine('t');
      const scheduleMachine = machine ? ` AND ms.machine_id = $${values.length}` : '';
      const [counts, tickets, schedules] = await Promise.all([
        db.query(`SELECT t.status, t.priority, COUNT(*)::int AS n FROM maintenance_tickets t
                   WHERE ${ticketScope} AND t.status NOT IN ('RESOLVED', 'CLOSED')${ticketMachine}
                   GROUP BY t.status, t.priority`, values),
        db.query(`SELECT t.title, t.status, t.priority, t.issue_type, t.created_at, t.due_date, (t.assigned_to IS NOT NULL) AS assigned,
                         m.machine_serial_no
                    FROM maintenance_tickets t JOIN machines m ON m.id = t.machine_id
                   WHERE ${ticketScope} AND t.status NOT IN ('RESOLVED', 'CLOSED')${ticketMachine}
                   ORDER BY CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, t.created_at DESC
                   LIMIT 10`, values),
        db.query(`SELECT ms.title, ms.maintenance_type, ms.scheduled_at, ms.status, m.machine_serial_no,
                         (ms.scheduled_at < NOW()) AS overdue
                    FROM maintenance_schedules ms JOIN machines m ON m.id = ms.machine_id
                   WHERE ${scheduleScope} AND ms.is_active = TRUE AND ms.status IN ('SCHEDULED', 'OVERDUE')
                     AND ms.scheduled_at < NOW() + INTERVAL '14 days'${scheduleMachine}
                   ORDER BY ms.scheduled_at
                   LIMIT 20`, values)
      ]);
      const byStatus = {}, byPriority = {};
      let open = 0;
      for (const r of counts.rows) { open += r.n; byStatus[r.status] = (byStatus[r.status] || 0) + r.n; byPriority[r.priority] = (byPriority[r.priority] || 0) + r.n; }
      const plan = s => ({ machine: s.machine_serial_no, title: clip(s.title, 80), type: s.maintenance_type, due: at(s.scheduled_at, ctx.timezone) });
      return {
        data: {
          as_of: at(new Date(), ctx.timezone), filters: { machine: machine?.name ?? null },
          open_tickets: open, by_status: byStatus, by_priority: byPriority,
          most_urgent: tickets.rows.map(t => ({ machine: t.machine_serial_no, title: clip(t.title, 80), status: t.status, priority: t.priority,
                                               issue: t.issue_type, raised: at(t.created_at, ctx.timezone), due: at(t.due_date, ctx.timezone), assigned: t.assigned })),
          schedules_overdue: schedules.rows.filter(s => s.overdue).slice(0, 10).map(plan),
          schedules_next_14_days: schedules.rows.filter(s => !s.overdue).slice(0, 10).map(plan)
        },
        source: { report: 'Maintenance', period: null, filters: { machine: machine?.name ?? null }, view: '/maintenance', download: null }
      };
    }
  },

  energy_summary: {
    access: ACCESS.energy,
    definition: {
      name: 'energy_summary',
      description: `Energy for a period of at most ${ENERGY_MAX_DAYS} days (as Dashboards → Energy): kWh, cost, kWh per part, the biggest consumers, use by shift, overload alerts, and how many machines report energy. Optionally one machine.`,
      input_schema: dated({ machine: NAMED_INPUT.machine })
    },
    async run(user, input, ctx) {
      const p = period(input, ctx.today, ENERGY_MAX_DAYS);
      const { machine } = await filtersOf(user, { machine: input.machine });
      const d = await energySvc.getEnergy({ company_id: user.company_id, from: p.from, to: p.to, machine_id: machine?.id, part: 'kpis,charts' });
      const k = d.kpis || {};
      const source = { report: 'Energy Dashboard', period: { from: p.from, to: p.to }, filters: { machine: machine?.name ?? null, shift: null },
                       view: `/energy-dashboard?${query({ from: p.from, to: p.to, machine_id: machine?.id })}`, download: null };
      if (k.total_kwh == null) {
        return { data: { report: 'Energy', period: source.period, filters: source.filters, records: 0, note: d.coverage?.note || null }, source };
      }
      return {
        data: {
          report: 'Energy', period: source.period, filters: source.filters, currency: d.currency || 'INR',
          totals: { kwh: k.total_kwh, cost: k.total_cost, kwh_per_part: k.kwh_per_part, parts: k.total_produced,
                    operating_hours: hours(k.total_operating_seconds), kwh_vs_previous_day_pct: k.kwh_vs_yesterday_pct,
                    overload_alerts: k.overload_alerts, overload_limit_set: k.overload_limit_set },
          coverage: d.coverage ? { machines: d.coverage.machines, reporting_energy: d.coverage.reporting, tariff_set: d.coverage.tariff_configured } : null,
          top_consumers: (d.top_consumers || []).map(m => ({ name: m.machine_serial_no, kwh: m.kwh, cost: m.cost, kwh_per_part: m.kwh_per_part })),
          by_shift: (d.by_shift || []).slice(0, 6).map(x => ({ shift: x.shift_name, kwh: x.kwh, run_hours: hours(x.run_seconds), parts: x.produced }))
        },
        source
      };
    }
  },

  program_transfer_status: {
    access: ACCESS.programs,
    definition: {
      name: 'program_transfer_status',
      description: 'Program Transfer now: whether the company\'s gateway is online, and for each machine the program next to send, how many wait, the last one the machine took or refused, and a backup asked for.',
      input_schema: { type: 'object', properties: { machine: NAMED_INPUT.machine }, additionalProperties: false }
    },
    async run(user, input, ctx) {
      const { machine } = await filtersOf(user, { machine: input.machine });
      const { gateway, machines } = await programsSvc.listMachines({ user });
      const listed = machines.filter(m => !machine || m.id === machine.id).slice(0, 40).map(m => ({
        machine: m.machine_serial_no,
        next_to_send: m.next?.program_name ?? null, waiting: m.waiting,
        last: m.last_report ? { program: m.last_report.program_name, result: m.last_report.delivery_status === 'DONE' ? 'on the machine' : 'refused',
                                reason: clip(m.last_report.delivery_message), at: at(m.last_report.delivered_at, ctx.timezone) } : null,
        backup_asked: !!m.backup_request, backup_failed: m.backup_failure ? clip(m.backup_failure.message) : null
      }));
      return {
        data: {
          gateway: gateway ? (gateway.online ? 'online' : gateway.last_seen_at ? `offline since ${at(gateway.last_seen_at, ctx.timezone)}` : 'set up, not connected yet')
                           : 'none yet — S&T sets it up',
          machines: listed
        },
        source: { report: 'Program Transfer', period: null, filters: { machine: machine?.name ?? null }, view: '/programs', download: null }
      };
    }
  },

  mexa_help: {
    access: null,
    definition: {
      name: 'mexa_help',
      description: 'How to do something in MEXA, and where it is: menus and pages, reports and downloads, OEE, quality, alarms, downtime, maintenance, Program Transfer, energy and tariff, machines and shifts, users and roles, notifications, this assistant, and who to ask for help.',
      input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'What the person wants to do or know, in a few words.' } },
                      required: ['topic'], additionalProperties: false }
    },
    async run(_user, input) {
      return { data: helpFor(String(input.topic || '').slice(0, 200)) };
    }
  },

  company_details: {
    access: null,
    definition: {
      name: 'company_details',
      description: 'This company\'s registered details: name, code, address, contact email and phone, timezone, plan, plants and how many active machines it has.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    async run(user) {
      // the approved fields only — never ids, logos, users, limits or anything another company has;
      // a person kept to one plant sees that plant only
      const plantId = effectivePlantId(user);
      const [{ rows: [c] }, { rows: plants }, { rows: [m] }] = await Promise.all([
        db.query(`
          SELECT c.company_name, c.company_code, c.address, c.contact_email, c.contact_phone, c.timezone,
                 to_char(c.created_at, 'DD Mon YYYY') AS registered_on, p.plan_name
            FROM companies c
            LEFT JOIN company_plans cp ON cp.company_id = c.id AND cp.is_active = TRUE
            LEFT JOIN plans p ON p.id = cp.plan_id
           WHERE c.id = $1`, [user.company_id]),
        db.query(`SELECT plant_name FROM plants WHERE company_id = $1 AND is_active = TRUE${plantId ? ' AND id = $2' : ''} ORDER BY plant_name`,
                 plantId ? [user.company_id, plantId] : [user.company_id]),
        db.query(`SELECT COUNT(*)::int AS n FROM machines WHERE company_id = $1 AND is_active = TRUE${plantSql('id')}`, [user.company_id])
      ]);
      if (!c) throw new ToolProblem('No company details.', { restricted: true });
      return {
        data: { ...c, plants: plants.map(x => x.plant_name), active_machines: m?.n ?? 0 },
        source: { report: 'Company details', period: null, filters: {}, view: null, download: null }
      };
    }
  }
};

/** What this person may look at, worked out once per question. */
async function accessFor(user) {
  const allowed = async keys => !(await denialForAny(user, keys));
  const [reports, oee, status, alarms, downtime, maintenance, energy, programs,
         oeeDashboard, reportsExport, oeeExport, liveDashboard, alarmDashboard, downtimeDashboard] = await Promise.all([
    allowed(ACCESS.production), allowed(ACCESS.oee), allowed(ACCESS.status), allowed(ACCESS.alarms), allowed(ACCESS.downtime),
    allowed(ACCESS.maintenance), allowed(ACCESS.energy), allowed(ACCESS.programs),
    allowed(['page:analytics-oee:view']), allowed(['page:reports:export']), allowed(['page:analytics-oee:export']),
    allowed(['page:dashboard:view']), allowed(['page:analytics-alarms:view']), allowed(['page:analytics-downtime:view'])
  ]);
  return { company: true, reports, oee, status, alarms, downtime, maintenance, energy, programs,
           oeeDashboard, reportsExport, oeeExport, liveDashboard, alarmDashboard, downtimeDashboard };
}

/** The tools this person may use (the rest are not offered). Company details, names and help are everyone's. */
function toolsFor(can) {
  const offered = ['mexa_help', 'machines_and_shifts', 'company_details'];
  if (can.reports) offered.push('production_report');
  if (can.oee) offered.push('oee_report');
  if (can.status) offered.push('machine_status');
  if (can.alarms) offered.push('alarm_summary');
  if (can.downtime) offered.push('downtime_summary');
  if (can.maintenance) offered.push('maintenance_status');
  if (can.energy) offered.push('energy_summary');
  if (can.programs) offered.push('program_transfer_status');
  return offered;
}

/**
 * Run one tool call. Never throws for a person's mistake: the model is told,
 * so it can ask. Run inside this person's read scope (their company and
 * plant) again, so the plant filter never rests on the request's context
 * surviving the wait for the model.
 */
async function runTool(user, name, input, ctx) {
  if (!ctx.offered.includes(name) || !Object.hasOwn(TOOLS, name)) {
    return { error: true, out: { restricted: true, message: 'This person may not see that.' } };
  }
  try {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const r = await readScope.run(user, () => TOOLS[name].run(user, args, ctx));
    return { error: false, out: r.data, source: r.source };
  } catch (err) {
    if (err instanceof ToolProblem) {
      return { error: true, out: { problem: err.message, ...(err.known ? { known: err.known } : {}), ...(err.candidates ? { candidates: err.candidates } : {}), ...(err.restricted ? { restricted: true } : {}) } };
    }
    if (err?.status && err.status < 500) return { error: true, out: { problem: err.message } };
    throw err;                       // a server fault: the question fails, nothing is counted
  }
}

module.exports = { TOOLS, ACCESS, accessFor, toolsFor, runTool, period, pick, ToolProblem };
