/*
 * Unit tests for tickets/ticket.service — the maintenance ticket lifecycle
 * (Create Ticket / Maintenance Ticket Details, the gap the Phase 2 review
 * flagged: no ticket workflow, no technician assignment, no alarm linking).
 *
 * db.connect()'s client.query is the same mock as db.query (see
 * helpers/mockDb.js), so every statement in a transaction — including the
 * literal BEGIN/COMMIT — consumes one queued response in order.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/tickets/ticket.service');

const company_id = 3;

beforeEach(() => resetDb());

describe('ticket.service.createTicket', () => {
  test('rejects without machine_id or title', async () => {
    await expect(svc.createTicket({ company_id, title: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createTicket({ company_id, machine_id: 1 })).rejects.toMatchObject({ status: 400 });
  });

  test('unassigned ticket starts OPEN', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                                                  // BEGIN
      { rows: [{ id: 1, status: 'OPEN', machine_id: 5, title: 'Spindle noise' }], rowCount: 1 }, // INSERT ticket
      { rows: [], rowCount: 0 },                                                  // INSERT history
      { rows: [], rowCount: 0 }                                                   // COMMIT
    );

    const ticket = await svc.createTicket({ company_id, machine_id: 5, title: 'Spindle noise', created_by: 9 });

    expect(ticket.status).toBe('OPEN');
    const insert = mockDb.calls()[1];
    expect(insert.text).toMatch(/INSERT INTO maintenance_tickets/i);
    expect(insert.params[7]).toBe('OPEN'); // status column

    const history = mockDb.calls()[2];
    expect(history.text).toMatch(/INSERT INTO ticket_status_history/i);
    // from_status and the 'Ticket created' note are SQL literals in this
    // query (NULL / 'Ticket created'), not bound params — only ticket_id,
    // to_status and changed_by are parameterized.
    expect(history.params).toEqual([1, 'OPEN', 9]);
  });

  test('assigning at creation starts ASSIGNED, not OPEN', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [{ id: 2, status: 'ASSIGNED' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }
    );

    await svc.createTicket({ company_id, machine_id: 5, title: 'Coolant leak', assigned_to: 42, created_by: 9 });

    const insert = mockDb.calls()[1];
    expect(insert.params[7]).toBe('ASSIGNED');
    expect(insert.params[8]).toBe(42);
  });

  test('links the originating alarm when alarm_id is given', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                                  // BEGIN
      { rows: [{ machine_id: 5 }], rowCount: 1 },                  // the alarm, locked
      { rows: [], rowCount: 0 },                                  // no open ticket for it
      { rows: [{ id: 3, status: 'OPEN' }], rowCount: 1 },          // INSERT
      { rows: [], rowCount: 0 },                                  // history
      { rows: [], rowCount: 0 }                                   // COMMIT
    );

    await svc.createTicket({ company_id, machine_id: 5, alarm_id: 77, title: 'ALARM on VMC-1', created_by: 9 });

    const [, lock, open, insert] = mockDb.calls();
    expect(lock.text).toMatch(/FROM machine_alarms WHERE id = \$1 AND company_id = \$2 FOR UPDATE/);
    expect(lock.params).toEqual([77, company_id]);
    expect(open.text).toMatch(/status NOT IN \('RESOLVED', 'CLOSED'\)/);
    expect(insert.params[2]).toBe(77); // alarm_id column
  });

  test('a second ticket for an alarm whose ticket is still open is refused, naming that ticket', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [{ machine_id: 5 }], rowCount: 1 },
      { rows: [{ id: 41, status: 'IN_PROGRESS' }], rowCount: 1 }
    );

    await expect(svc.createTicket({ company_id, machine_id: 5, alarm_id: 77, title: 'again', created_by: 9 }))
      .rejects.toMatchObject({ status: 409, code: 'TICKET_EXISTS', ticket_id: 41, ticket_status: 'IN_PROGRESS',
                               message: 'Ticket #41 is already open for this alarm' });
    expect(mockDb.calls().some(c => /INSERT INTO maintenance_tickets/.test(c.text))).toBe(false);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });

  test('a ticket on another machine than its alarm is refused', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [{ machine_id: 8 }], rowCount: 1 });
    await expect(svc.createTicket({ company_id, machine_id: 5, alarm_id: 77, title: 'x', created_by: 9 }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls().some(c => /INSERT INTO maintenance_tickets/.test(c.text))).toBe(false);
  });

  test('an alarm that is gone is a 404, nothing written', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await expect(svc.createTicket({ company_id, machine_id: 5, alarm_id: 77, title: 'x', created_by: 9 }))
      .rejects.toMatchObject({ status: 404, message: 'Alarm not found' });
  });

  test('rolls back if the insert fails', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },       // BEGIN
      new Error('constraint violation') // INSERT ticket fails
    );

    await expect(svc.createTicket({ company_id, machine_id: 5, title: 'x', created_by: 9 }))
      .rejects.toThrow('constraint violation');

    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
});

describe('ticket.service.updateTicketStatus', () => {
  test('rejects an unrecognized status', async () => {
    await expect(svc.updateTicketStatus(1, company_id, { status: 'DONE', changed_by: 9 }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('throws 404 when the ticket does not exist (or belongs to another company)', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },  // BEGIN
      { rows: [], rowCount: 0 }   // SELECT ... FOR UPDATE finds nothing
    );

    await expect(svc.updateTicketStatus(999, company_id, { status: 'ASSIGNED', changed_by: 9 }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('OPEN -> RESOLVED stamps resolved_at and writes history with both statuses', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                       // BEGIN
      { rows: [{ status: 'OPEN' }], rowCount: 1 },      // SELECT ... FOR UPDATE
      { rows: [{ id: 1, status: 'RESOLVED' }], rowCount: 1 }, // UPDATE
      { rows: [], rowCount: 0 },                       // INSERT history
      { rows: [], rowCount: 0 }                        // COMMIT
    );

    await svc.updateTicketStatus(1, company_id, { status: 'RESOLVED', note: 'Replaced fuse', changed_by: 9 });

    const update = mockDb.calls()[2];
    expect(update.text).toMatch(/resolved_at = NOW\(\)/);
    expect(update.text).toMatch(/closed_at = NULL/);

    const history = mockDb.calls()[3];
    expect(history.params).toEqual([1, 'OPEN', 'RESOLVED', 'Replaced fuse', 9]);
  });

  test('RESOLVED -> CLOSED stamps closed_at and preserves the earlier resolved_at', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'RESOLVED' }], rowCount: 1 },
      { rows: [{ id: 1, status: 'CLOSED' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }
    );

    await svc.updateTicketStatus(1, company_id, { status: 'CLOSED', changed_by: 9 });

    const update = mockDb.calls()[2];
    // Already resolved earlier — CLOSED must not wipe that timestamp.
    expect(update.text).toMatch(/resolved_at = resolved_at/);
    expect(update.text).toMatch(/closed_at = NOW\(\)/);
  });

  test.each(['RESOLVED', 'CLOSED'])('a ticket raised from an alarm, %s: the alarm is resolved with it', async (status) => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'IN_PROGRESS', alarm_id: 77 }], rowCount: 1 },
      { rows: [{ id: 12, status }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 }
    );

    await svc.updateTicketStatus(12, company_id, { status, note: 'Referenced the magazine', changed_by: 9 });

    const alarm = mockDb.calls().find(c => /UPDATE machine_alarms/.test(c.text));
    expect(alarm.text).toMatch(/is_resolved = TRUE, resolved_by = \$1, resolved_at = NOW\(\)/);
    expect(alarm.text).toMatch(/WHERE id = \$3 AND company_id = \$4 AND is_resolved = FALSE/);   // never re-stamps one already resolved
    expect(alarm.params).toEqual([9, 'Resolved with maintenance ticket #12: Referenced the magazine', 77, company_id]);
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });

  test('a ticket with no alarm, or one moved to In progress, leaves alarms alone', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 }, { rows: [{ status: 'OPEN', alarm_id: null }], rowCount: 1 },
      { rows: [{ id: 1 }], rowCount: 1 }, { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }
    );
    await svc.updateTicketStatus(1, company_id, { status: 'RESOLVED', changed_by: 9 });
    mockDb.queueResponse(
      { rows: [], rowCount: 0 }, { rows: [{ status: 'OPEN', alarm_id: 77 }], rowCount: 1 },
      { rows: [{ id: 2 }], rowCount: 1 }, { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }
    );
    await svc.updateTicketStatus(2, company_id, { status: 'IN_PROGRESS', changed_by: 9 });
    expect(mockDb.calls().some(c => /UPDATE machine_alarms/.test(c.text))).toBe(false);
  });

  test('re-opening a resolved ticket clears resolved_at', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'RESOLVED' }], rowCount: 1 },
      { rows: [{ id: 1, status: 'IN_PROGRESS' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }
    );

    await svc.updateTicketStatus(1, company_id, { status: 'IN_PROGRESS', changed_by: 9 });

    const update = mockDb.calls()[2];
    expect(update.text).toMatch(/resolved_at = NULL/);
  });
});

describe('ticket.service.assignTicket', () => {
  test('rejects without assigned_to', async () => {
    await expect(svc.assignTicket(1, company_id, { changed_by: 9 })).rejects.toMatchObject({ status: 400 });
  });

  test('assigning an OPEN ticket advances it to ASSIGNED and logs history', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                              // BEGIN
      { rows: [{ status: 'OPEN' }], rowCount: 1 },             // SELECT ... FOR UPDATE
      { rows: [{ id: 1, status: 'ASSIGNED', assigned_to: 42 }], rowCount: 1 }, // UPDATE
      { rows: [], rowCount: 0 },                              // INSERT history
      { rows: [], rowCount: 0 }                               // COMMIT
    );

    const ticket = await svc.assignTicket(1, company_id, { assigned_to: 42, changed_by: 9 });

    expect(ticket.status).toBe('ASSIGNED');
    const update = mockDb.calls()[2];
    expect(update.params).toEqual([42, 'ASSIGNED', 1, company_id]);
    expect(mockDb.calls()[3].text).toMatch(/INSERT INTO ticket_status_history/i);
  });

  test('re-assigning a ticket already IN_PROGRESS keeps its status and skips a history row', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'IN_PROGRESS' }], rowCount: 1 },
      { rows: [{ id: 1, status: 'IN_PROGRESS', assigned_to: 55 }], rowCount: 1 },
      { rows: [], rowCount: 0 }   // COMMIT — no history insert this time
    );

    const ticket = await svc.assignTicket(1, company_id, { assigned_to: 55, changed_by: 9 });

    expect(ticket.status).toBe('IN_PROGRESS');
    expect(mockDb.calls()).toHaveLength(4); // BEGIN, SELECT, UPDATE, COMMIT — no history insert
  });
});

describe('ticket.service.getTickets', () => {
  test('always scopes by company_id, and layers on optional filters', async () => {
    mockDb.queueResponse(
      { rows: [{ count: '2' }] },
      { rows: [{ id: 1 }, { id: 2 }] }
    );

    const result = await svc.getTickets({ company_id, status: 'OPEN', machine_id: 5 });

    // Service builds conditions machine_id-then-status-then-priority-then-
    // assigned_to, so params/placeholders follow that order, not call order.
    const [countCall, dataCall] = mockDb.calls();
    expect(countCall.params).toEqual([company_id, 5, 'OPEN']);
    expect(dataCall.text).toMatch(/t\.company_id = \$1/);
    expect(dataCall.text).toMatch(/t\.machine_id = \$2/);
    expect(dataCall.text).toMatch(/t\.status = \$3/);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
  });

  test('the header: priority sorts in its working order; filters and the title search are bound', async () => {
    mockDb.queueResponse({ rows: [{ count: '0' }] }, { rows: [] });
    await svc.getTickets({ company_id, sort: 'priority', dir: 'desc', f_status: 'OPEN,ASSIGNED', f_assigned: '__blank__', q_title: '41' });
    const [countCall, dataCall] = mockDb.calls();
    expect(dataCall.text).toMatch(/ORDER BY CASE t\.priority WHEN 'CRITICAL' THEN 4 .* END DESC NULLS LAST, t\.created_at DESC, t\.id DESC/s);
    expect(countCall.text).toMatch(/JOIN machines m ON m\.id = t\.machine_id LEFT JOIN users u ON u\.id = t\.assigned_to/);
    expect(countCall.text).toMatch(/\(t\.status\)::text = ANY\(\$2::text\[\]\)/);
    expect(countCall.text).toMatch(/NULLIF\(btrim\(\(u\.username\)::text\), ''\) IS NULL/);
    expect(countCall.params).toEqual([company_id, ['OPEN', 'ASSIGNED'], '%41%']);
  });

  test('open=true: every ticket not yet resolved or closed, counted and paged by the database', async () => {
    mockDb.queueResponse({ rows: [{ count: '0' }] }, { rows: [] });
    await svc.getTickets({ company_id, open: 'true', limit: 100 });
    const [countCall, dataCall] = mockDb.calls();
    expect(countCall.text).toMatch(/t\.status NOT IN \('RESOLVED', 'CLOSED'\)/);
    expect(dataCall.params.slice(-2)).toEqual([100, 0]);
  });
});

describe('ticket.service.getTicketById', () => {
  test('throws 404 for a ticket outside the caller’s company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 });
    await expect(svc.getTicketById(1, company_id)).rejects.toMatchObject({ status: 404 });
  });

  test('returns the ticket with its status history attached', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 1, title: 'Spindle noise' }], rowCount: 1 },
      { rows: [{ from_status: null, to_status: 'OPEN' }, { from_status: 'OPEN', to_status: 'ASSIGNED' }] }
    );

    const ticket = await svc.getTicketById(1, company_id);

    expect(ticket.title).toBe('Spindle noise');
    expect(ticket.history).toHaveLength(2);
    expect(ticket.history[1].to_status).toBe('ASSIGNED');
  });
});

/*
 * Alarm severity is not ticket priority. Raising a ticket from a NORMAL alarm
 * sent "NORMAL" into the ticket_priority enum, and Postgres answered
 * "invalid input value for enum ticket_priority" — so 850 of the 885 alarms
 * in the field could not be ticketed at all, while a CRITICAL one worked by
 * coincidence.
 */
describe('ticket priority is translated from alarm severity', () => {
  const queueCreate = () => mockDb.queueResponse(
    { rows: [], rowCount: 0 },
    { rows: [{ id: 1 }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 }
  );
  const priorityOf = () => mockDb.calls()[1].params[6];

  test.each([
    ['NORMAL', 'MEDIUM'], ['normal', 'MEDIUM'], ['CRITICAL', 'CRITICAL'],
    ['INFORMATION', 'LOW'], ['WARNING', 'MEDIUM'], ['MAJOR', 'HIGH'], ['HIGH', 'HIGH']
  ])('a %s alarm becomes a %s ticket', async (severity, expected) => {
    queueCreate();
    await svc.createTicket({ company_id, machine_id: 5, title: 'Alarm', issue_type: 'ALARM', priority: severity, created_by: 9 });
    expect(priorityOf()).toBe(expected);
  });

  test('the four real priorities pass through untouched', async () => {
    for (const p of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      resetDb();
      queueCreate();
      await svc.createTicket({ company_id, machine_id: 5, title: 't', priority: p, created_by: 9 });
      expect(priorityOf()).toBe(p);
    }
  });

  test('no priority given still defaults to MEDIUM', async () => {
    queueCreate();
    await svc.createTicket({ company_id, machine_id: 5, title: 't', created_by: 9 });
    expect(priorityOf()).toBe('MEDIUM');
  });

  test('a word that is neither is a 400, not a database error', async () => {
    await expect(svc.createTicket({ company_id, machine_id: 5, title: 't', priority: 'URGENT', created_by: 9 }))
      .rejects.toMatchObject({ status: 400, message: 'priority must be one of LOW, MEDIUM, HIGH, CRITICAL' });
  });

  test('an unknown issue_type is a 400 as well', async () => {
    await expect(svc.createTicket({ company_id, machine_id: 5, title: 't', issue_type: 'FIRE', created_by: 9 }))
      .rejects.toMatchObject({ status: 400, message: 'issue_type must be one of BREAKDOWN, ALARM, INSPECTION, OTHER' });
  });

  test('updating a ticket translates severity and leaves blanks alone', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
    await svc.updateTicket(1, company_id, { priority: 'NORMAL' });
    expect(mockDb.calls()[0].params[3]).toBe('MEDIUM');

    resetDb();
    mockDb.queueResponse({ rows: [{ id: 1 }], rowCount: 1 });
    await svc.updateTicket(1, company_id, { title: 'only the title' });
    expect(mockDb.calls()[0].params[3]).toBeNull();   // priority untouched
    expect(mockDb.calls()[0].params[2]).toBeNull();   // issue_type untouched
  });

  test('updating with a word that is neither is a 400', async () => {
    await expect(svc.updateTicket(1, company_id, { priority: 'SUPER' })).rejects.toMatchObject({ status: 400 });
  });
});
