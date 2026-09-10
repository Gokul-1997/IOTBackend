/*
 * Unit tests for maintenance/pm-engine.service — the loop that turns
 * repeated alarms into preventive tickets.
 *
 * The behaviour that matters most is idempotence. The cron fires every 15
 * minutes and a user can trigger it by hand; if a tick raised a second
 * ticket for a problem that already has one open, a machine alarming all
 * day would bury the maintenance queue in duplicates.
 *
 * db.connect()'s client.query is the same mock as db.query (helpers/mockDb),
 * so BEGIN and COMMIT each consume a queued response in order.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const engine = require('../../src/maintenance/pm-engine.service');

const company_id = 4;

beforeEach(() => resetDb());

describe('evaluateCompany', () => {

  test('raises a ticket for each breached rule and logs its history', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },                                    // BEGIN
      { rows: [{ id: 101, machine_id: 5, threshold_id: 1 },         // INSERT ... RETURNING
                { id: 102, machine_id: 6, threshold_id: 2 }] },
      { rows: [], rowCount: 2 },                                    // history insert
      { rows: [], rowCount: 0 }                                     // COMMIT
    );

    const res = await engine.evaluateCompany(company_id, { createdBy: 9 });

    expect(res.created).toBe(2);
    expect(mockDb.calls()[1].text).toMatch(/INSERT INTO maintenance_tickets/i);
    expect(mockDb.calls()[2].text).toMatch(/INSERT INTO ticket_status_history/i);
    expect(mockDb.calls()[2].params[0]).toEqual([101, 102]);
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });

  test('writes no history when nothing was raised', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },   // BEGIN
      { rows: [] },                // INSERT matched nothing
      { rows: [], rowCount: 0 }    // COMMIT
    );

    const res = await engine.evaluateCompany(company_id);

    expect(res.created).toBe(0);
    // an empty unnest() insert would be a pointless round trip
    expect(mockDb.calls().some(c => /ticket_status_history/.test(c.text))).toBe(false);
  });

  test('skips rules that already have a live ticket (idempotence)', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });
    await engine.evaluateCompany(company_id);

    const sql = mockDb.calls()[1].text;
    // the NOT EXISTS against open statuses is what stops duplicates
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/mt\.threshold_id\s*=\s*c\.threshold_id/);
    expect(sql).toMatch(/mt\.machine_id\s*=\s*c\.machine_id/);
    expect(mockDb.calls()[1].params[1]).toEqual(['OPEN', 'ASSIGNED', 'IN_PROGRESS']);
  });

  test('only counts alarms inside each rule’s own window', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });
    await engine.evaluateCompany(company_id);

    const sql = mockDb.calls()[1].text;
    expect(sql).toMatch(/make_interval\(hours => t\.window_hours\)/);
    expect(sql).toMatch(/HAVING COUNT\(a\.id\) >= t\.threshold_count/);
  });

  test('a company-wide rule covers every machine, a scoped rule only its own', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });
    await engine.evaluateCompany(company_id);

    expect(mockDb.calls()[1].text).toMatch(/t\.machine_id IS NULL OR m\.id = t\.machine_id/);
  });

  test('due date comes from the rule, not a hardcoded SLA', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });
    await engine.evaluateCompany(company_id);

    expect(mockDb.calls()[1].text).toMatch(/NOW\(\) \+ make_interval\(hours => r\.due_hours\)/);
  });

  test('everything is scoped to the one company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });
    await engine.evaluateCompany(company_id);

    const insert = mockDb.calls()[1];
    expect(insert.text).toMatch(/t\.company_id = \$1/);
    expect(insert.params[0]).toBe(company_id);
  });

  test('rolls back if the insert fails, leaving no half-written tickets', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },
      new Error('constraint violation')
    );

    await expect(engine.evaluateCompany(company_id)).rejects.toThrow('constraint violation');
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
});

describe('evaluateAll', () => {

  test('runs every company that has an active rule', async () => {
    mockDb.queueResponse(
      { rows: [{ company_id: 4 }, { company_id: 5 }] },  // companies with rules
      { rows: [], rowCount: 0 }, { rows: [{ id: 1 }] }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }, { rows: [] },           { rows: [], rowCount: 0 }
    );

    const res = await engine.evaluateAll();

    expect(res.companies).toBe(2);
    expect(res.created).toBe(1);
    expect(res.failed).toEqual([]);
  });

  test('one company failing does not stop the others', async () => {
    mockDb.queueResponse(
      { rows: [{ company_id: 4 }, { company_id: 5 }] },
      { rows: [], rowCount: 0 },
      new Error('company 4 is broken'),                  // 4 blows up
      { rows: [], rowCount: 0 },                         // its ROLLBACK
      { rows: [], rowCount: 0 }, { rows: [{ id: 7 }] },  // 5 still runs
      { rows: [], rowCount: 1 }, { rows: [], rowCount: 0 }
    );

    const res = await engine.evaluateAll();

    // a bad rule on one tenant must not stall preventive maintenance for all
    expect(res.created).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].company_id).toBe(4);
  });
});
