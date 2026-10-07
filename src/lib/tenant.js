/*
 * Every record a request names must belong to the caller's company.
 *
 * Services take ids straight from the request (machine_id, shift_id,
 * assigned_to …). Scoping the row being written by company_id is not enough:
 * the row can still point at another company's machine. A probe of every
 * route as one company with another company's ids
 * (tools/loadtest/multitenant/probe.mjs) found three reads and nine writes
 * that did exactly that — a quality entry or a component written onto
 * another company's machine changed that company's OEE.
 *
 * ownedOrThrow() checks every named id against its table in one query and
 * answers 404: whether an id exists in another company is not the caller's
 * business either.
 */
const db = require('../db');

const TABLES = {
  machine_id: 'machines', machine_ids: 'machines',
  shift_id: 'shifts', component_id: 'components', operator_id: 'operators',
  user_id: 'users', assigned_to: 'users', assigned_user_id: 'users',
  line_id: 'line', plant_id: 'plants', downtime_reason_id: 'downtime_reasons',
  maintenance_schedule_id: 'maintenance_schedules', alarm_id: 'machine_alarms',
  ticket_id: 'maintenance_tickets'
};
const LABELS = {
  machines: 'Machine', shifts: 'Shift', components: 'Component', operators: 'Operator',
  users: 'User', line: 'Line', plants: 'Plant', downtime_reasons: 'Downtime reason',
  maintenance_schedules: 'Maintenance schedule', machine_alarms: 'Alarm', maintenance_tickets: 'Ticket'
};
// rows with no company are shared by every company (the built-in downtime reasons)
const SHARED = new Set(['downtime_reasons']);

/**
 * @param {number} companyId  the caller's company (req.user.company_id)
 * @param {object} refs       e.g. { machine_id: 12, shift_id: 3, machine_ids: [4, 5] };
 *                            undefined / null / '' entries are skipped
 * @param {object} [client]   a pool client, to check inside a transaction
 */
async function ownedOrThrow(companyId, refs, client = db) {
  if (!companyId) throw { status: 403, message: 'This account belongs to no company' };

  const checks = [];
  for (const [key, value] of Object.entries(refs)) {
    if (value === undefined || value === null || value === '') continue;
    const table = TABLES[key];
    if (!table) throw new Error(`ownedOrThrow: no table for ${key}`);
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) continue;
    const ids = list.map(Number);
    if (ids.some(n => !Number.isInteger(n) || n <= 0)) {
      throw { status: 400, message: `${LABELS[table]} id is not valid` };
    }
    checks.push({ table, ids: [...new Set(ids)] });
  }
  if (!checks.length) return;

  const sql = checks
    .map((c, i) => `SELECT ${i} AS k, count(*)::int AS n FROM ${c.table} WHERE id = ANY($${i + 2}::int[])
                    AND ${SHARED.has(c.table) ? '(company_id = $1 OR company_id IS NULL)' : 'company_id = $1'}`)
    .join(' UNION ALL ');
  const { rows } = await client.query(sql, [companyId, ...checks.map(c => c.ids)]);
  for (const r of rows) {
    if (r.n !== checks[r.k].ids.length) throw { status: 404, message: `${LABELS[checks[r.k].table]} not found` };
  }
}

module.exports = { ownedOrThrow };
