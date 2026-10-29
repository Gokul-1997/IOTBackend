const db = require('../db');
const { pagination } = require('../lib/pagination');
const valid = require('../lib/work-validation');
const { ownedOrThrow } = require('../lib/tenant');
const { addMachinePlantScope } = require('../lib/plant-scope');
const { tableQuery } = require('../lib/table-query');
const { machineOrder } = require('../lib/machine-order');

const VALID_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const VALID_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VALID_ISSUE_TYPES = ['BREAKDOWN', 'ALARM', 'INSPECTION', 'OTHER'];

/* An alarm's severity is the machine's word for how bad it is — CRITICAL or
   NORMAL on these controllers, INFORMATION on others. A ticket's priority is
   ours, and the column is an enum. Raising a ticket from an alarm passed the
   severity straight through, so every NORMAL alarm (850 of 885 in the field)
   failed with Postgres's own "invalid input value for enum ticket_priority".
   The two vocabularies are translated here, in the one place both the web and
   the mobile app go through. */
const SEVERITY_TO_PRIORITY = {
  CRITICAL: 'CRITICAL', FATAL: 'CRITICAL', EMERGENCY: 'CRITICAL',
  MAJOR: 'HIGH', HIGH: 'HIGH', ALARM: 'HIGH',
  NORMAL: 'MEDIUM', 'NON-CRITICAL': 'MEDIUM', NON_CRITICAL: 'MEDIUM',
  WARNING: 'MEDIUM', MEDIUM: 'MEDIUM',
  MINOR: 'LOW', LOW: 'LOW', INFO: 'LOW', INFORMATION: 'LOW', INFORMATIONAL: 'LOW'
};

/** A priority the column will accept, or a 400 saying what is allowed —
 *  never a raw Postgres enum error. */
function toPriority(value, fallback = 'MEDIUM') {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toUpperCase();
  if (VALID_PRIORITIES.includes(v)) return v;
  if (SEVERITY_TO_PRIORITY[v]) return SEVERITY_TO_PRIORITY[v];
  throw { status: 400, message: `priority must be one of ${VALID_PRIORITIES.join(', ')}` };
}

function toIssueType(value, fallback = 'BREAKDOWN') {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toUpperCase();
  if (VALID_ISSUE_TYPES.includes(v)) return v;
  throw { status: 400, message: `issue_type must be one of ${VALID_ISSUE_TYPES.join(', ')}` };
}

exports.toPriority = toPriority;

/* open=true: every ticket not yet resolved or closed. The Maintenance page
   asked for the newest 20 of any status and hid the finished ones itself, so
   an open ticket older than the 20 newest never showed (29 Oct 2026). */
/* The Tickets table's header (lib/table-query.js): sort any column —
   priority and status in their working order, not A–Z — filter machine,
   issue, priority, assignee (__blank__: unassigned) and status, search the
   title or the ticket number. */
const PRIORITY_RANK = `CASE t.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 END`;
const STATUS_RANK = `CASE t.status WHEN 'OPEN' THEN 1 WHEN 'ASSIGNED' THEN 2 WHEN 'IN_PROGRESS' THEN 3 WHEN 'RESOLVED' THEN 4 WHEN 'CLOSED' THEN 5 END`;
const TICKET_TABLE = {
  sort: {
    machine: dir => machineOrder('m.machine_serial_no', dir), title: 't.title', issue: 't.issue_type::text',
    priority: PRIORITY_RANK, assigned: 'u.username', status: STATUS_RANK, created: 't.created_at'
  },
  filter: { machine: 'm.machine_serial_no', issue: 't.issue_type', priority: 't.priority', assigned: 'u.username', status: 't.status' },
  search: { title: `'#' || t.id || ' ' || t.title` }
};

exports.getTickets = async (q) => {
  const { company_id, machine_id, status, priority, assigned_to, open, page = 1, limit = 20, plant_id = null } = q;
  const conditions = [`t.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id)   { conditions.push(`t.machine_id = $${i++}`);   params.push(machine_id); }
  if (status)       { conditions.push(`t.status = $${i++}`);       params.push(status); }
  if (open === true || open === 'true') conditions.push(`t.status NOT IN ('RESOLVED', 'CLOSED')`);
  if (priority)     { conditions.push(`t.priority = $${i++}`);     params.push(priority); }
  if (assigned_to)  { conditions.push(`t.assigned_to = $${i++}`);  params.push(assigned_to); }
  addMachinePlantScope(conditions, params, 't', plant_id);
  const table = tableQuery(q, TICKET_TABLE, params);
  conditions.push(...table.where);
  i = params.length + 1;

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { pageNum, limitNum, offset } = pagination(page, limit);

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM maintenance_tickets t
               JOIN machines m ON m.id = t.machine_id LEFT JOIN users u ON u.id = t.assigned_to ${where}`, params),
    db.query(
      `SELECT t.*, m.machine_serial_no,
              u.username AS assigned_to_name,
              c.username AS created_by_name,
              a.alarm_type, a.severity AS alarm_severity
       FROM maintenance_tickets t
       JOIN machines m ON m.id = t.machine_id
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users c ON c.id = t.created_by
       LEFT JOIN machine_alarms a ON a.id = t.alarm_id
       ${where}
       ORDER BY ${table.orderBy ? `${table.orderBy}, ` : ''}t.created_at DESC, t.id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    )
  ]);

  return {
    data: dataRes.rows,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: parseInt(countRes.rows[0].count),
      totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum)
    }
  };
};

exports.getTicketById = async (id, company_id, plant_id = null) => {
  const ticketRes = await db.query(
    `SELECT t.*, m.machine_serial_no,
            u.username AS assigned_to_name,
            c.username AS created_by_name,
            a.alarm_type, a.severity AS alarm_severity, a.message AS alarm_message,
            a.alarm_code, a.started_at AS alarm_started_at, a.is_resolved AS alarm_is_resolved
     FROM maintenance_tickets t
     JOIN machines m ON m.id = t.machine_id
     LEFT JOIN users u ON u.id = t.assigned_to
     LEFT JOIN users c ON c.id = t.created_by
     LEFT JOIN machine_alarms a ON a.id = t.alarm_id
     WHERE t.id = $1 AND t.company_id = $2 ${plant_id == null ? '' : 'AND m.company_id=$2 AND m.plant_id=$3'}`,
    [id, company_id, ...(plant_id == null ? [] : [plant_id])]
  );
  if (!ticketRes.rowCount) throw { status: 404, message: 'Ticket not found' };

  const historyRes = await db.query(
    `SELECT h.*, u.username AS changed_by_name
     FROM ticket_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.ticket_id = $1
     ORDER BY h.created_at ASC`,
    [id]
  );

  return { ...ticketRes.rows[0], history: historyRes.rows };
};

exports.createTicket = async ({ company_id, machine_id, alarm_id, title, description, issue_type, priority, assigned_to, created_by, plant_id = null }) => {
  if (!machine_id || !title) throw { status: 400, message: 'machine_id and title are required' };
  await ownedOrThrow(company_id, { machine_id, alarm_id, assigned_to });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    /* One open ticket per alarm (29 Oct 2026). Raising a ticket from an
       alarm made a new one every time — after a reload, from a second
       person, from the phone — so one fault became several tickets. The
       alarm row is locked while we look, so two at once cannot both pass;
       the second hears which ticket is already open. A ticket must also be
       on the alarm's own machine. */
    if (alarm_id) {
      const alarmRes = await client.query(
        `SELECT machine_id FROM machine_alarms WHERE id = $1 AND company_id = $2 FOR UPDATE`, [alarm_id, company_id]);
      if (!alarmRes.rowCount) throw { status: 404, message: 'Alarm not found' };
      if (Number(alarmRes.rows[0].machine_id) !== Number(machine_id)) {
        throw { status: 400, message: 'The ticket must be on the alarm\'s own machine' };
      }
      const openRes = await client.query(
        `SELECT id, status FROM maintenance_tickets
          WHERE alarm_id = $1 AND company_id = $2 AND status NOT IN ('RESOLVED', 'CLOSED')
          ORDER BY id DESC LIMIT 1`, [alarm_id, company_id]);
      if (openRes.rowCount) {
        const open = openRes.rows[0];
        throw { status: 409, code: 'TICKET_EXISTS', message: `Ticket #${open.id} is already open for this alarm`,
                ticket_id: Number(open.id), ticket_status: open.status };
      }
    }

    const status = assigned_to ? 'ASSIGNED' : 'OPEN';
    const res = await client.query(
      `INSERT INTO maintenance_tickets
         (company_id, machine_id, alarm_id, title, description, issue_type, priority, status, assigned_to, created_by)
       ${plant_id == null ? 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)' : `SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE EXISTS
         (SELECT 1 FROM machines WHERE id=$2 AND company_id=$1 AND plant_id=$11)
         AND ($9::int IS NULL OR EXISTS (SELECT 1 FROM users WHERE id=$9 AND company_id=$1 AND is_active=TRUE AND (plant_id=$11 OR plant_id IS NULL)))`} RETURNING *`,
      [company_id, machine_id, alarm_id || null, title, description || null,
       toIssueType(issue_type), toPriority(priority), status, assigned_to || null, created_by, ...(plant_id == null ? [] : [plant_id])]
    );
    if (!res.rows.length) throw { status: 404, message: 'Machine not found in your plant' };
    const ticket = res.rows[0];

    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, note, changed_by)
       VALUES ($1, NULL, $2, 'Ticket created', $3)`,
      [ticket.id, status, created_by]
    );

    await client.query('COMMIT');
    return ticket;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.updateTicket = async (id, company_id, fields, plant_id = null) => {
  const { title, description, issue_type, priority, parts_used, downtime_minutes } = fields;
  const minutes = valid.nonnegative(downtime_minutes, 'downtime_minutes', { integer: true });
  /* null leaves the column as it is (COALESCE below); anything given is
     checked here rather than by the enum, which answers with a 500. */
  const unset = v => v === undefined || v === null || v === '';
  const newPriority  = unset(priority)   ? null : toPriority(priority);
  const newIssueType = unset(issue_type) ? null : toIssueType(issue_type);
  const res = await db.query(
    `UPDATE maintenance_tickets
     SET title = COALESCE($1, title),
         description = COALESCE($2, description),
         issue_type = COALESCE($3, issue_type),
         priority = COALESCE($4, priority),
         parts_used = COALESCE($5, parts_used),
         downtime_minutes = COALESCE($6, downtime_minutes),
         updated_at = NOW()
     WHERE id = $7 AND company_id = $8
       ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=maintenance_tickets.machine_id AND scoped_machine.company_id=$8 AND scoped_machine.plant_id=$9)'}
     RETURNING *`,
    [title, description, newIssueType, newPriority, parts_used, minutes, id, company_id, ...(plant_id == null ? [] : [plant_id])]
  );
  if (!res.rowCount) throw { status: 404, message: 'Ticket not found' };
  return res.rows[0];
};

/**
 * Dedicated status-change endpoint: writes the transition to history and
 * stamps resolved_at/closed_at so those timestamps never drift out of sync
 * with the status itself (a plain field update on the ticket row wouldn't
 * — those timestamps are a downstream *effect* of a status change, not a
 * fact the caller supplies).
 */
exports.updateTicketStatus = async (id, company_id, { status, note, changed_by, plant_id = null }) => {
  if (!VALID_STATUSES.includes(status)) {
    throw { status: 400, message: `status must be one of ${VALID_STATUSES.join(', ')}` };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      `SELECT * FROM maintenance_tickets WHERE id = $1 AND company_id = $2
        ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=maintenance_tickets.machine_id AND scoped_machine.company_id=$2 AND scoped_machine.plant_id=$3)'} FOR UPDATE`,
      [id, company_id, ...(plant_id == null ? [] : [plant_id])]
    );
    if (!currentRes.rowCount) throw { status: 404, message: 'Ticket not found' };
    const fromStatus = currentRes.rows[0].status;
    if (fromStatus === status) {
      await client.query('COMMIT');
      return currentRes.rows[0];
    }

    // Keyed on the TARGET status only, not the source: resolved_at is NOW()
    // on entering RESOLVED, preserved on RESOLVED->CLOSED (closing keeps the
    // original resolution time), and cleared for any other target — which is
    // exactly what re-opening a resolved/closed ticket back to OPEN/ASSIGNED/
    // IN_PROGRESS needs (an earlier from-status-keyed version got this wrong:
    // it preserved resolved_at whenever the ticket was COMING FROM resolved,
    // even when re-opening, so a re-opened ticket kept a stale resolved_at).
    const resolvedAtSql = status === 'RESOLVED' ? 'NOW()' : (status === 'CLOSED' ? 'resolved_at' : 'NULL');
    const closedAtSql = status === 'CLOSED' ? 'NOW()' : 'NULL';

    const updateRes = await client.query(
      `UPDATE maintenance_tickets
       SET status = $1, resolved_at = ${resolvedAtSql}, closed_at = ${closedAtSql}, updated_at = NOW()
       WHERE id = $2 AND company_id = $3
         ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=maintenance_tickets.machine_id AND scoped_machine.company_id=$3 AND scoped_machine.plant_id=$4)'}
       RETURNING *`,
      [status, id, company_id, ...(plant_id == null ? [] : [plant_id])]
    );
    if (!updateRes.rowCount) throw { status: 404, message: 'Ticket not found in your plant' };

    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, fromStatus, status, note || null, changed_by]
    );

    /* The ticket raised from an alarm is done: so is the alarm (29 Oct 2026).
       It stayed "Active" on Machine Alarms after the repair, for someone to
       resolve a second time. Only an alarm nobody has resolved yet; re-opening
       the ticket leaves the alarm as it is. */
    const alarmId = currentRes.rows[0].alarm_id;
    if (alarmId && (status === 'RESOLVED' || status === 'CLOSED')) {
      await client.query(
        `UPDATE machine_alarms
            SET is_resolved = TRUE, resolved_by = $1, resolved_at = NOW(), resolution_note = $2
          WHERE id = $3 AND company_id = $4 AND is_resolved = FALSE`,
        [changed_by, `Resolved with maintenance ticket #${id}${note ? `: ${note}` : ''}`, alarmId, company_id]
      );
    }

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/** Who a ticket can be assigned to: the company's active users. The page
 *  used the admin-only user list, which every other role was refused — so a
 *  MAINTENANCE user could never pick an assignee. Names only. */
exports.getAssignees = async (company_id, plant_id = null) => {
  if (!company_id) return [];
  const { rows } = await db.query(
    `SELECT id, username FROM users WHERE company_id = $1 AND is_active = true ${plant_id == null ? '' : 'AND (plant_id=$2 OR plant_id IS NULL)'} ORDER BY username`,
    [company_id, ...(plant_id == null ? [] : [plant_id])]
  );
  return rows;
};

exports.assignTicket = async (id, company_id, { assigned_to, changed_by, plant_id = null }) => {
  if (!assigned_to) throw { status: 400, message: 'assigned_to is required' };
  await ownedOrThrow(company_id, { assigned_to });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      `SELECT status FROM maintenance_tickets WHERE id = $1 AND company_id = $2
        ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=maintenance_tickets.machine_id AND scoped_machine.company_id=$2 AND scoped_machine.plant_id=$3)'} FOR UPDATE`,
      [id, company_id, ...(plant_id == null ? [] : [plant_id])]
    );
    if (!currentRes.rowCount) throw { status: 404, message: 'Ticket not found' };
    const fromStatus = currentRes.rows[0].status;
    // Assigning a still-OPEN ticket also advances it to ASSIGNED; re-assigning
    // one already in progress just changes the technician, status untouched.
    const toStatus = fromStatus === 'OPEN' ? 'ASSIGNED' : fromStatus;

    const updateRes = await client.query(
      `UPDATE maintenance_tickets SET assigned_to = $1, status = $2, updated_at = NOW()
       WHERE id = $3 AND company_id = $4
         ${plant_id == null ? '' : `AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=maintenance_tickets.machine_id AND scoped_machine.company_id=$4 AND scoped_machine.plant_id=$5)
           AND EXISTS (SELECT 1 FROM users WHERE id=$1 AND company_id=$4 AND is_active=TRUE AND (plant_id=$5 OR plant_id IS NULL))`} RETURNING *`,
      [assigned_to, toStatus, id, company_id, ...(plant_id == null ? [] : [plant_id])]
    );
    if (!updateRes.rowCount) throw { status: 404, message: 'Ticket not found in your plant' };

    if (toStatus !== fromStatus) {
      await client.query(
        `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, note, changed_by)
         VALUES ($1, $2, $3, 'Assigned', $4)`,
        [id, fromStatus, toStatus, changed_by]
      );
    }

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.getSummary = async (company_id, plant_id = null) => {
  const res = await db.query(
    `SELECT status, priority, COUNT(*)::int AS count
     FROM maintenance_tickets t
     WHERE company_id = $1 AND status NOT IN ('RESOLVED', 'CLOSED')
       ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=t.machine_id AND scoped_machine.company_id=$1 AND scoped_machine.plant_id=$2)'}
     GROUP BY status, priority`,
    [company_id, ...(plant_id == null ? [] : [plant_id])]
  );
  return res.rows;
};
