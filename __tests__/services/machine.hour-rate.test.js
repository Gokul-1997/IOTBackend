/*
 * A machine's hour rate (machines.hour_rate, migration 034): what an hour of
 * it costs, used to price idle and alarm time. S AND T's rates run from ₹350
 * to ₹2,800 an hour.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { cleanHourRate, costOf } = require('../../src/machines/hour-rate');
const machines = require('../../src/machines/machine.service');

beforeEach(() => resetDb());

describe('cleanHourRate', () => {
  test.each([[500, 500], ['2800', 2800], [' 1,200 ', 1200], ['380.456', 380.46], [0, 0]])(
    '%p is stored as %p', (input, stored) => expect(cleanHourRate(input)).toBe(stored));

  test.each([null, undefined, '', '   '])('%p means "not set"', v => expect(cleanHourRate(v)).toBeNull());

  test.each([-1, 'abc', '12x', 1000001, Infinity])('%p is refused with a 400 the form can show', v => {
    expect(() => cleanHourRate(v)).toThrow(expect.objectContaining({ status: 400, code: 'BAD_HOUR_RATE' }));
  });
});

describe('costOf', () => {
  test('hours lost × the rate, in whole rupees', () => {
    expect(costOf(3600, 500)).toBe(500);
    expect(costOf(5400, '380.00')).toBe(570);      // NUMERIC comes back from pg as a string
    expect(costOf(0, 1200)).toBe(0);
  });
  test('no rate: no cost, rather than ₹0', () => {
    expect(costOf(3600, null)).toBeNull();
    expect(costOf(3600, undefined)).toBeNull();
  });
});

describe('the machine API keeps the rate', () => {
  const req = body => ({ user: { company_id: 4 }, params: { id: '25' }, body });

  test('an edit stores the cleaned rate, and an empty one clears it', async () => {
    mockDb.queueResponse({ rows: [{ id: 25 }], rowCount: 1 }, { rows: [], rowCount: 0 });
    await machines.updateMachine(req({ hour_rate: '1,200' }));
    const update = mockDb.calls().find(c => /UPDATE machines/.test(c.text));
    expect(update.text).toMatch(/hour_rate = \$1/);
    expect(update.params[0]).toBe(1200);

    resetDb();
    mockDb.queueResponse({ rows: [{ id: 25 }], rowCount: 1 }, { rows: [], rowCount: 0 });
    await machines.updateMachine(req({ hour_rate: '' }));
    expect(mockDb.calls().find(c => /UPDATE machines/.test(c.text)).params[0]).toBeNull();
  });

  test('a bad rate is refused before anything is written', async () => {
    await expect(machines.updateMachine(req({ hour_rate: '-5' }))).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls().some(c => /UPDATE machines/.test(c.text))).toBe(false);
  });

  test('the machine list carries the rate for the form', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [{ total: 0 }] });
    await machines.getMachines({ user: { company_id: 4 }, query: {} });
    expect(mockDb.calls()[0].text).toMatch(/m\.hour_rate/);
  });
});
