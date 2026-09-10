const db = require('../db');

const VALID_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

exports.getTickets = async ({ company_id, machine_id, status, priority, assigned_to, page = 1, limit = 20 }) => {
  const conditions = [`t.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id)   { conditions.push(`t.machine_id = $${i++}`);   params.push(machine_id); }
  if (status)       { conditions.push(`t.status = $${i++}`);       params.push(status); }
  if (priority)     { conditions.push(`t.priority = $${i++}`);     params.push(priority); }
  if (assigned_to)  { conditions.push(`t.assigned_to = $${i++}`);  params.push(assigned_to); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, parseInt(limit) || 20);
  const offset = (pageNum - 1) * limitNum;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM maintenance_tickets t ${where}`, params),
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
       ORDER BY t.created_at DESC
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

exports.getTicketById = async (id, company_id) => {
  const ticketRes = await db.query(
    `SELECT t.*, m.machine_serial_no,
            u.username AS assigned_to_name,
            c.username AS created_by_name,
            a.alarm_type, a.severity AS alarm_severity, a.message AS alarm_message
     FROM maintenance_tickets t
     JOIN machines m ON m.id = t.machine_id
     LEFT JOIN users u ON u.id = t.assigned_to
     LEFT JOIN users c ON c.id = t.created_by
     LEFT JOIN machine_alarms a ON a.id = t.alarm_id
     WHERE t.id = $1 AND t.company_id = $2`,
    [id, company_id]
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

exports.createTicket = async ({ company_id, machine_id, alarm_id, title, description, issue_type, priority, assigned_to, created_by }) => {
  if (!machine_id || !title) throw { status: 400, message: 'machine_id and title are required' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const status = assigned_to ? 'ASSIGNED' : 'OPEN';
    const res = await client.query(
      `INSERT INTO maintenance_tickets
         (company_id, machine_id, alarm_id, title, description, issue_type, priority, status, assigned_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [company_id, machine_id, alarm_id || null, title, description || null,
       issue_type || 'BREAKDOWN', priority || 'MEDIUM', status, assigned_to || null, created_by]
    );
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

exports.updateTicket = async (id, company_id, fields) => {
  const { title, description, issue_type, priority, parts_used, downtime_minutes } = fields;
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
     RETURNING *`,
    [title, description, issue_type, priority, parts_used, downtime_minutes, id, company_id]
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
exports.updateTicketStatus = async (id, company_id, { status, note, changed_by }) => {
  if (!VALID_STATUSES.includes(status)) {
    throw { status: 400, message: `status must be one of ${VALID_STATUSES.join(', ')}` };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      `SELECT status FROM maintenance_tickets WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, company_id]
    );
    if (!currentRes.rowCount) throw { status: 404, message: 'Ticket not found' };
    const fromStatus = currentRes.rows[0].status;

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
       RETURNING *`,
      [status, id, company_id]
    );

    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, fromStatus, status, note || null, changed_by]
    );

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

exports.assignTicket = async (id, company_id, { assigned_to, changed_by }) => {
  if (!assigned_to) throw { status: 400, message: 'assigned_to is required' };

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query(
      `SELECT status FROM maintenance_tickets WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, company_id]
    );
    if (!currentRes.rowCount) throw { status: 404, message: 'Ticket not found' };
    const fromStatus = currentRes.rows[0].status;
    // Assigning a still-OPEN ticket also advances it to ASSIGNED; re-assigning
    // one already in progress just changes the technician, status untouched.
    const toStatus = fromStatus === 'OPEN' ? 'ASSIGNED' : fromStatus;

    const updateRes = await client.query(
      `UPDATE maintenance_tickets SET assigned_to = $1, status = $2, updated_at = NOW()
       WHERE id = $3 AND company_id = $4 RETURNING *`,
      [assigned_to, toStatus, id, company_id]
    );

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

exports.getSummary = async (company_id) => {
  const res = await db.query(
    `SELECT status, priority, COUNT(*)::int AS count
     FROM maintenance_tickets
     WHERE company_id = $1 AND status NOT IN ('RESOLVED', 'CLOSED')
     GROUP BY status, priority`,
    [company_id]
  );
  return res.rows;
};
