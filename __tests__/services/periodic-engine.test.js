/*
 * Unit tests for maintenance/periodic-engine.service — the loop that turns
 * a recurring schedule into dated tickets.
 *
 * Two properties carry this screen, and both fail silently if wrong:
 *
 *  - Idempotence. The cron fires every 15 minutes, a user can trigger a
 *    run by hand, and pm2 runs several API instances, so the same tick
 *    genuinely happens twice at once. A weekly greasing job that
 *    double-raised would become ninety-six tickets a day.
 *
 *  - Catch-up. A schedule that came due three times while nobody was
 *    looking must produce the occurrences it missed, not jump to next
 *    week. Maintenance that was never done is exactly what the compliance
 *    figure exists to show, so a skipped occurrence flatters the number.
 *
 * db.connect()'s client.query is the same mock as db.query (helpers/mockDb),
 * so BEGIN and COMMIT each consume a queued response in order.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const engine = require('../../src/maintenance/periodic-engine.service');

const company_id = 4;

/** A schedule row as the engine's SELECT returns it. */
const schedule = (over = {}) => ({
  id: 1, machine_id: 5, title: 'Grease the ways', description: null,
  frequency: 'WEEKLY', next_due_at: '2026-09-01T02:00:00.000Z',
  assigned_user_id: null, grace_days: 0, maintenance_type: 'PREVENTIVE',
  ...over
});

/**
 * The engine asks Postgres to add each interval step. Answer those with a
 * date far in the future so the catch-up loop terminates after one pass,
 * unless a test wants more.
 */
function queueStepAnswers(n, future = '2099-01-01T00:00:00.000Z') {
  for (let i = 0; i < n; i++) mockDb.queueResponse({ rows: [{ next: future }] });
}

beforeEach(() => resetDb());

describe('evaluateCompany', () => {

  test('raises a ticket for a due schedule and advances it', async () => {
    mockDb.queueResponse(
      { rows: [], rowCount: 0 },              // BEGIN
      { rows: [schedule()] },                 // due schedules
      { rows: [], rowCount: 1 }               // ticket INSERT
    );
    queueStepAnswers(1);
    mockDb.queueResponse(
      { rows: [], rowCount: 1 },              // schedule UPDATE
      { rows: [], rowCount: 0 }               // COMMIT
    );

    const res = await engine.evaluateCompany(company_id, { createdBy: 9 });

    expect(res.created).toBe(1);
    expect(res.advanced).toBe(1);
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });

  test('the insert refuses to duplicate a live occurrence', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [schedule()] }, { rows: [], rowCount: 0 });
    queueStepAnswers(1);
    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 });

    await engine.evaluateCompany(company_id);

    const insert = mockDb.calls().find(c => /INSERT INTO maintenance_tickets/i.test(c.text));
    // one live ticket per schedule per due date is what stops the queue
    // filling with the same job every quarter of an hour
    expect(insert.text).toMatch(/NOT EXISTS/);
    expect(insert.text).toMatch(/mt\.schedule_id\s*=\s*\$3/);
    expect(insert.text).toMatch(/mt\.due_date\s*=\s*\$8/);
    expect(insert.params.at(-1)).toEqual(['OPEN', 'ASSIGNED', 'IN_PROGRESS']);
  });

  test('due schedules are locked so two cluster instances cannot both advance one', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });

    await engine.evaluateCompany(company_id);

    const select = mockDb.calls()[1];
    // without this both instances read the same rows as due, and although
    // the unique index rejects the second insert, the second advance would
    // still skip an occurrence
    expect(select.text).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  test('catches up every occurrence that was missed', async () => {
    // Three weeks behind: three tickets, not one.
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [schedule()] });

    const past = ['2026-09-08T02:00:00.000Z', '2026-09-09T02:00:00.000Z'];
    mockDb.queueResponse({ rows: [], rowCount: 1 });          // occurrence 1
    mockDb.queueResponse({ rows: [{ next: past[0] }] });
    mockDb.queueResponse({ rows: [], rowCount: 1 });          // occurrence 2
    mockDb.queueResponse({ rows: [{ next: past[1] }] });
    mockDb.queueResponse({ rows: [], rowCount: 1 });          // occurrence 3
    mockDb.queueResponse({ rows: [{ next: '2099-01-01T00:00:00.000Z' }] });
    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 });

    const res = await engine.evaluateCompany(company_id);

    expect(res.created).toBe(3);
  });

  test('a long-abandoned schedule cannot flood the board in one pass', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [schedule({ frequency: 'DAILY' })] });
    // every step stays in the past, so only the cap ends the loop
    for (let i = 0; i < 60; i++) {
      mockDb.queueResponse({ rows: [], rowCount: 1 });
      mockDb.queueResponse({ rows: [{ next: '2026-09-01T02:00:00.000Z' }] });
    }
    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 });

    const res = await engine.evaluateCompany(company_id);

    // the backlog still clears — the next tick takes the next batch — but
    // one run cannot raise a year of daily tickets at once
    expect(res.created).toBe(engine.MAX_CATCHUP_PER_PASS);
  });

  test('intervals are computed by Postgres, not by JavaScript dates', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [schedule({ frequency: 'MONTHLY' })] },
                         { rows: [], rowCount: 1 });
    queueStepAnswers(1);
    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 });

    await engine.evaluateCompany(company_id);

    const step = mockDb.calls().find(c => /::interval/.test(c.text));
    // setMonth() would drift one month after 31 January onto 3 March and
    // keep the schedule there
    expect(step.params[1]).toBe('1 month');
  });

  test.each([
    ['DAILY', '1 day'], ['WEEKLY', '1 week'], ['MONTHLY', '1 month'],
    ['QUARTERLY', '3 months'], ['HALF_YEARLY', '6 months'], ['YEARLY', '1 year']
  ])('%s steps by %s', (frequency, expected) => {
    expect(engine.FREQUENCY_STEP[frequency]).toBe(expected);
  });

  test('an unknown frequency is skipped rather than guessed at', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 },
                         { rows: [schedule({ frequency: 'FORTNIGHTLY' })] },
                         { rows: [], rowCount: 0 });

    const res = await engine.evaluateCompany(company_id);

    expect(res.created).toBe(0);
    expect(res.advanced).toBe(0);
    // putting it on the wrong cycle would be worse than leaving it alone
    expect(mockDb.calls().some(c => /INSERT INTO maintenance_tickets/i.test(c.text))).toBe(false);
  });

  test('a schedule with a technician is raised already assigned', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 },
                         { rows: [schedule({ assigned_user_id: 42 })] },
                         { rows: [], rowCount: 1 });
    queueStepAnswers(1);
    mockDb.queueResponse({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 });

    await engine.evaluateCompany(company_id);

    const insert = mockDb.calls().find(c => /INSERT INTO maintenance_tickets/i.test(c.text));
    expect(insert.params).toContain('ASSIGNED');
    expect(insert.params).toContain(42);
  });

  test('everything is scoped to the one company', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });

    await engine.evaluateCompany(company_id);

    expect(mockDb.calls()[1].text).toMatch(/company_id = \$1/);
    expect(mockDb.calls()[1].params[0]).toBe(company_id);
  });

  test('rolls back if a write fails, leaving no half-generated cycle', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 0 }, new Error('deadlock detected'));

    await expect(engine.evaluateCompany(company_id)).rejects.toThrow('deadlock detected');
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
});

describe('evaluateAll', () => {

  test('runs every company that has an active recurring schedule', async () => {
    mockDb.queueResponse({ rows: [{ company_id: 4 }, { company_id: 5 }] });
    for (let i = 0; i < 2; i++) {
      mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });
    }

    const res = await engine.evaluateAll();

    expect(res.companies).toBe(2);
    expect(res.failed).toEqual([]);
  });

  test('one company failing does not stop the others', async () => {
    mockDb.queueResponse({ rows: [{ company_id: 4 }, { company_id: 5 }] });
    mockDb.queueResponse({ rows: [], rowCount: 0 }, new Error('company 4 is broken'), { rows: [], rowCount: 0 });
    mockDb.queueResponse({ rows: [], rowCount: 0 }, { rows: [] }, { rows: [], rowCount: 0 });

    const res = await engine.evaluateAll();

    // a bad schedule on one tenant must not stall maintenance for all
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].company_id).toBe(4);
    expect(res.companies).toBe(2);
  });
});
