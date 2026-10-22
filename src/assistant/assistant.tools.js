/*
 * What the assistant can look at: a few fixed, read-only report functions.
 *
 * The model never writes SQL and never names a company. Each tool runs the
 * same server code as the screens (report.service, the OEE Dashboard's
 * figures), for the signed-in person's company and plant (the request's read
 * scope), and only when that person may open the matching page — the same
 * role-and-company check the API uses. A tool the person may not use is not
 * offered at all. Nothing here writes to the database.
 */
const db = require('../db');
const reports = require('../reports/report.service');
const oee = require('../dashboard/oee.dashboard.service');
const { denialForAny } = require('../middleware/access.middleware');
const readScope = require('../lib/read-scope');
const { plantSql, sharedEntityPlantSql } = readScope;
const { effectivePlantId } = require('../lib/plant-scope');
const { MAX_DIRECT_DAYS } = require('../reports/report.limits');

/** Pages whose figures a tool shows; the person needs one of them. */
const ACCESS = {
  production: ['page:reports:view'],
  oee: ['page:reports:view', 'page:oee-reports:view', 'page:analytics-oee:view'],
  company: ['page:reports:view', 'page:oee-reports:view']
};

/** A tool's input the person (or the model) got wrong: told to the model, which can ask the person. */
class ToolProblem extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

/* ── shared pieces ── */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function period(input, today) {
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
  if (days > MAX_DIRECT_DAYS) throw new ToolProblem(`A period can be at most ${MAX_DIRECT_DAYS} days; this one is ${days}.`);
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
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

/* ── the tools ── */

const TOOLS = {
  machines_and_shifts: {
    access: ACCESS.company,
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

  company_details: {
    access: ACCESS.company,
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
  const [reportsView, oeeView, companyView, oeeDashboard, reportsExport, oeeExport] = await Promise.all([
    allowed(ACCESS.production), allowed(ACCESS.oee), allowed(ACCESS.company),
    allowed(['page:analytics-oee:view']), allowed(['page:reports:export']), allowed(['page:analytics-oee:export'])
  ]);
  return { reports: reportsView, oee: oeeView, company: companyView, oeeDashboard, reportsExport, oeeExport };
}

/** The tools this person may use (the rest are not offered). */
function toolsFor(can) {
  const offered = [];
  if (can.company) offered.push('machines_and_shifts', 'company_details');
  if (can.reports) offered.push('production_report');
  if (can.oee) offered.push('oee_report');
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
