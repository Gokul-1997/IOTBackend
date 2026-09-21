/**
 * Maintenance Report — the contract line "the system shall generate and
 * export maintenance reports in Excel, CSV, and PDF formats".
 *
 * The Maintenance *Dashboard* answers "what is the floor doing right now":
 * machine health, live alarms, condition trends. This answers the other
 * question — "what did maintenance do over this period, and what did it
 * cost us in stopped time" — so it reads the ticket record rather than
 * telemetry.
 *
 * Two numbers here are easy to state wrongly, so they are defined once:
 *
 *   MTTR     mean time to repair, measured from the ticket being raised to
 *            it being resolved. Only resolved tickets count; averaging in
 *            still-open ones would report a repair that has not happened.
 *
 *   Downtime the minutes entered on the ticket by whoever worked it, NOT
 *            idle time derived from telemetry. Those are different
 *            quantities (see downtime.service.js) and adding them together
 *            would double-count. A ticket with nothing entered counts as
 *            zero minutes and is listed as unrecorded, rather than being
 *            quietly dropped from the total.
 */

const db = require('../db');

const STATUSES   = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const ISSUES     = ['BREAKDOWN', 'ALARM', 'INSPECTION', 'OTHER'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const SETTLED    = ['RESOLVED', 'CLOSED'];

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseId(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${label} must be a positive integer`, 400);
  return n;
}

function parseEnum(v, allowed, label) {
  if (v === undefined || v === null || v === '') return null;
  const up = String(v).toUpperCase();
  if (!allowed.includes(up)) throw httpError(`${label} must be one of ${allowed.join(', ')}`, 400);
  return up;
}

/** Defaults to the last 30 days — a maintenance period, not a shift. */
function resolveRange({ from, to }) {
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
  if (from && !isDate(from)) throw httpError('from must be a date in YYYY-MM-DD form', 400);
  if (to && !isDate(to))     throw httpError('to must be a date in YYYY-MM-DD form', 400);

  const end   = to   ? `${to} 23:59:59.999` : new Date().toISOString();
  const start = from ? `${from} 00:00:00`
                     : new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10) + ' 00:00:00';

  if (new Date(start) > new Date(end)) throw httpError('from must not be after to', 400);
  return { start, end };
}

/**
 * Every query in this file goes through here, so company_id is always the
 * first bound parameter and can never be omitted by a later edit.
 */
function buildFilter(q) {
  const companyId = parseId(q.company_id, 'company_id');
  if (!companyId) throw httpError('No company on this account', 403);

  const { start, end } = resolveRange(q);
  const where  = ['t.company_id = $1', 't.created_at >= $2', 't.created_at <= $3'];
  const params = [companyId, start, end];
  let i = 4;

  const machineId = parseId(q.machine_id, 'machine_id');
  if (machineId) { where.push(`t.machine_id = $${i++}`); params.push(machineId); }

  const status = parseEnum(q.status, STATUSES, 'status');
  if (status) { where.push(`t.status = $${i++}`); params.push(status); }

  const issueType = parseEnum(q.issue_type, ISSUES, 'issue_type');
  if (issueType) { where.push(`t.issue_type = $${i++}`); params.push(issueType); }

  const priority = parseEnum(q.priority, PRIORITIES, 'priority');
  if (priority) { where.push(`t.priority = $${i++}`); params.push(priority); }

  const search = String(q.search || '').trim();
  if (search) {
    where.push(`(t.title ILIKE $${i} OR m.machine_serial_no ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }

  return { sql: where.join(' AND '), params, start, end, machineId, next: i };
}

/* Repair hours, from raised to resolved. Written once and reused so the
   KPI and the per-machine table can never drift apart. */
const REPAIR_HOURS = `EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600.0`;

async function listTickets(f, { page, limit }) {
  const pageNum  = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const offset   = (pageNum - 1) * limitNum;

  const [countRes, rowsRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS n
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
        WHERE ${f.sql}`, f.params),
    db.query(
      `SELECT t.id, t.title, t.issue_type, t.priority, t.status,
              t.downtime_minutes, t.parts_used, t.resolution_note,
              t.created_at, t.resolved_at, t.closed_at,
              m.machine_serial_no,
              a.username AS assigned_to_name,
              c.username AS created_by_name,
              ROUND((${REPAIR_HOURS})::numeric, 2)::float AS repair_hours
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
         LEFT JOIN users a ON a.id = t.assigned_to
         LEFT JOIN users c ON c.id = t.created_by
        WHERE ${f.sql}
        ORDER BY t.created_at DESC
        LIMIT $${f.next} OFFSET $${f.next + 1}`,
      [...f.params, limitNum, offset])
  ]);

  const total = countRes.rows[0].n;
  return {
    data: rowsRes.rows,
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.max(1, Math.ceil(total / limitNum))
  };
}

exports.getReport = async (q = {}) => {
  const f = buildFilter(q);

  const [kpiRes, byMachineRes, byTypeRes, byStatusRes, trendRes, tickets] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS tickets,
              COUNT(*) FILTER (WHERE t.status = ANY($${f.next}))::int  AS settled,
              COUNT(*) FILTER (WHERE NOT (t.status = ANY($${f.next})))::int AS open,
              COUNT(*) FILTER (WHERE t.issue_type = 'BREAKDOWN')::int  AS breakdowns,
              COUNT(*) FILTER (WHERE t.priority = 'CRITICAL')::int     AS critical,
              COALESCE(SUM(t.downtime_minutes), 0)::int                AS downtime_minutes,
              COUNT(*) FILTER (WHERE t.downtime_minutes IS NULL)::int  AS downtime_unrecorded,
              ROUND(AVG(${REPAIR_HOURS}) FILTER (WHERE t.resolved_at IS NOT NULL)::numeric, 2)::float AS mttr_hours,
              COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int   AS mttr_basis
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
        WHERE ${f.sql}`, [...f.params, SETTLED]),

    db.query(
      `SELECT m.machine_serial_no,
              COUNT(*)::int AS tickets,
              COUNT(*) FILTER (WHERE t.issue_type = 'BREAKDOWN')::int AS breakdowns,
              COALESCE(SUM(t.downtime_minutes), 0)::int AS downtime_minutes,
              ROUND(AVG(${REPAIR_HOURS}) FILTER (WHERE t.resolved_at IS NOT NULL)::numeric, 2)::float AS mttr_hours
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
        WHERE ${f.sql}
        GROUP BY m.machine_serial_no
        ORDER BY COALESCE(SUM(t.downtime_minutes), 0) DESC, COUNT(*) DESC
        LIMIT 20`, f.params),

    db.query(
      `SELECT t.issue_type, COUNT(*)::int AS n
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
        WHERE ${f.sql}
        GROUP BY t.issue_type`, f.params),

    db.query(
      `SELECT t.status, COUNT(*)::int AS n
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
        WHERE ${f.sql}
        GROUP BY t.status`, f.params),

    db.query(
      `SELECT date_trunc('day', t.created_at) AS day,
              COUNT(*)::int AS raised,
              COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved
         FROM maintenance_tickets t
         JOIN machines m ON m.id = t.machine_id
        WHERE ${f.sql}
        GROUP BY 1 ORDER BY 1`, f.params),

    listTickets(f, { page: q.page, limit: q.limit })
  ]);

  const kpis = kpiRes.rows[0];
  const countsFor = (rows, key, allowed) =>
    Object.fromEntries(allowed.map(k => [k, rows.find(r => r[key] === k)?.n || 0]));

  return {
    filters: {
      from: f.start.slice(0, 10),
      to:   f.end.slice(0, 10),
      machine_id: f.machineId
    },
    updated_at: new Date().toISOString(),
    kpis: {
      ...kpis,
      /* Stated rather than left to the reader: an average over three
         tickets is not the same claim as one over three hundred. */
      mttr_basis_note: kpis.mttr_basis
        ? `Mean of ${kpis.mttr_basis} resolved ticket${kpis.mttr_basis === 1 ? '' : 's'}`
        : 'No ticket has been resolved in this period',
      downtime_note: kpis.downtime_unrecorded
        ? `${kpis.downtime_unrecorded} ticket${kpis.downtime_unrecorded === 1 ? '' : 's'} recorded no downtime`
        : null
    },
    by_machine: byMachineRes.rows,
    by_type:    countsFor(byTypeRes.rows,   'issue_type', ISSUES),
    by_status:  countsFor(byStatusRes.rows, 'status',     STATUSES),
    trend:      trendRes.rows,
    tickets
  };
};

exports.getExportRows = async (q = {}) => {
  const f = buildFilter(q);
  const rows = await listTickets(f, { page: 1, limit: 200 });
  const stamp = d => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '');

  return rows.data.map(r => ({
    'Machine':     r.machine_serial_no,
    'Title':       r.title,
    'Type':        r.issue_type,
    'Priority':    r.priority,
    'Status':      r.status,
    'Raised':      stamp(r.created_at),
    'Resolved':    stamp(r.resolved_at),
    'Repair (h)':  r.repair_hours ?? '',
    'Downtime (min)': r.downtime_minutes ?? '',
    'Assigned to': r.assigned_to_name || 'Unassigned',
    'Parts used':  r.parts_used || ''
  }));
};

exports.resolveRange = resolveRange;
exports.buildFilter  = buildFilter;
