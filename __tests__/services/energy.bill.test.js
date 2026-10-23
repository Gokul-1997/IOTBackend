/*
 * The electricity bill: its dates (Tariff & Rates) and the forecast the
 * Energy Dashboard shows (dashboard/energy-bill.service.js). The arithmetic
 * has its own tests (energy.forecast.test.js); these are about what is read,
 * what is refused, and never showing a short "so far" as if it were whole.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/dashboard/energy-hourly.service', () => ({
  ...jest.requireActual('../../src/dashboard/energy-hourly.service'),
  hours: jest.fn(),
  kick: jest.fn()
}));
const { mockDb, resetDb } = require('../helpers/mockDb');
const hourly = require('../../src/dashboard/energy-hourly.service');
const readScope = require('../../src/lib/read-scope');
const svc = require('../../src/dashboard/energy-bill.service');
const fc = require('../../src/dashboard/energy-forecast');

const H = fc.HOUR_MS;
const at = (day, hh = 0, mm = 0) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
const NOW = at('2026-10-23', 10, 30);
const ENTERED = { rows: [{ start: '2026-10-12', end: '2026-11-11', updated_at: '2026-10-12T05:00:00Z' }] };
const MACHINES = { rows: [
  { id: 1, machine_serial_no: 'VMC - 1 - F', rate: '10.95', currency: 'INR' },
  { id: 2, machine_serial_no: 'VMC - 2 - F', rate: '10.95', currency: 'INR' }
] };

/** Machine 1 drew 6 kWh every hour since 1 Sep; machine 99 is another plant's. */
function hoursFrom(from) {
  const rows = [];
  for (let h = fc.istHour(from); h <= fc.istHour(NOW); h += H) {
    rows.push({ machine_id: 1, hour: h, kwh: 6, readings: 240 });
    rows.push({ machine_id: 99, hour: h, kwh: 1000, readings: 240 });
  }
  return rows;
}

beforeEach(() => {
  resetDb();
  hourly.hours.mockReset();
  hourly.kick.mockReset();
});

describe('the forecast', () => {
  test('no bill dates yet: says so, and reads no history', async () => {
    mockDb.queueResponse({ rows: [] }, MACHINES);
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r).toMatchObject({ configured: false, currency: 'INR', scope: { machine_id: null } });
    expect(hourly.hours).not.toHaveBeenCalled();
  });

  test('this bill, its day, and only the machines in scope', async () => {
    mockDb.queueResponse(ENTERED, MACHINES);
    hourly.hours.mockImplementation(async (_c, from) => ({ rows: hoursFrom(at('2026-09-01')), completeFrom: from }));
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });

    // from the bill before this one (12 Sep), five weeks back at the least
    const [company, from] = hourly.hours.mock.calls[0];
    expect(company).toBe(4);
    expect(from).toBe(at('2026-09-12'));
    expect(hourly.kick).not.toHaveBeenCalled();

    expect(r).toMatchObject({
      configured: true, preparing: false, repeats: 'Every month',
      current: { start: '2026-10-12', end: '2026-11-11', days: 31 },
      period: { start: '2026-10-12', end: '2026-11-11', days: 31, day: 12 }
    });
    expect(r.period.days_left).toBeCloseTo(19.6, 1);
    const hoursSoFar = (fc.istHour(NOW) - at('2026-10-12')) / H + 1;
    expect(r.so_far.kwh).toBe(6 * hoursSoFar);                // machine 99 is not counted
    expect(r.so_far.cost).toBeCloseTo(6 * hoursSoFar * 10.95, 2);
    expect(r.machines).toMatchObject({ in_scope: 2, metered: 1, forecast: 1 });
    expect(r.previous).toMatchObject({ start: '2026-09-12', end: '2026-10-11' });
  });

  test('the bill\'s own days not worked out yet: no short total, and the history is caught up', async () => {
    mockDb.queueResponse(ENTERED, MACHINES);
    hourly.hours.mockResolvedValue({ rows: hoursFrom(at('2026-10-21')), completeFrom: at('2026-10-21') });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r.preparing).toBe(true);
    expect(r.so_far).toBeNull();
    expect(r.forecast).toBeNull();
    expect(hourly.kick).toHaveBeenCalledWith(4);
  });

  test('older weeks still coming: the bill is whole, the usual use rests on less', async () => {
    mockDb.queueResponse(ENTERED, MACHINES);
    hourly.hours.mockResolvedValue({ rows: hoursFrom(at('2026-10-10')), completeFrom: at('2026-10-10') });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r.preparing).toBe(false);
    expect(r.forecast).not.toBeNull();
    expect(r.history.weeks).toBe(1);
    expect(r.previous).toBeNull();
    expect(hourly.kick).toHaveBeenCalledWith(4);
  });

  test('one machine: narrowed in SQL; another company\'s machine is not found', async () => {
    mockDb.queueResponse(ENTERED, { rows: [MACHINES.rows[0]] });
    hourly.hours.mockResolvedValue({ rows: [], completeFrom: at('2026-09-12') });
    const r = await svc.getBill({ company_id: 4, machine_id: '1' }, { now: NOW });
    expect(r.scope).toEqual({ machine_id: 1, machine: 'VMC - 1 - F' });
    expect(mockDb.calls()[1].params).toEqual([4, 1]);

    mockDb.queueResponse(ENTERED, { rows: [] });
    await expect(svc.getBill({ company_id: 4, machine_id: 77 }, { now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(svc.getBill({ company_id: 4, machine_id: 'x' }, { now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  test('the clock is the server\'s: a ?now= in the request changes nothing', async () => {
    mockDb.queueResponse({ rows: [] }, MACHINES);
    const r = await svc.getBill({ company_id: 4, now: '0' });
    expect(r.configured).toBe(false);
  });
});

describe('the bill dates', () => {
  const save = (body, user) => {
    const call = () => svc.saveBillPeriod({ company_id: 4, user_id: 9, ...body });
    return user ? readScope.run(user, call) : call();
  };
  const today = fc.istDay(Date.now());

  test('saved as entered, and shown as this bill, the next, and how they repeat', async () => {
    const start = fc.addDays(today, -5), end = fc.addDays(fc.addDays(today, -5), 29);
    mockDb.queueResponse({ rows: [] }, { rows: [{ start, end, updated_at: null }] });
    const r = await save({ period_start: start, period_end: end });
    const [upsert] = mockDb.calls();
    expect(upsert.text).toMatch(/INSERT INTO energy_billing[\s\S]*ON CONFLICT \(company_id\) DO UPDATE/);
    expect(upsert.params).toEqual([4, start, end, 9]);
    expect(r).toMatchObject({ configured: true, entered: { start, end }, current: { start, end } });
    expect(r.next.start).toBe(fc.addDays(end, 1));
  });

  test.each([
    [{ period_start: '', period_end: '' }, /dates/],
    [{ period_start: '2026-02-31', period_end: '2026-03-30' }, /dates/],
    [{ period_start: '2026-10-12', period_end: '2026-10-17' }, /at least 7 days/],
    [{ period_start: '2026-10-12', period_end: '2027-01-13' }, /at most 3 months/]
  ])('refused before anything is saved: %p', async (body, message) => {
    await expect(save(body)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('a first day years back or months ahead is a typing mistake', async () => {
    await expect(save({ period_start: fc.addDays(today, -500), period_end: fc.addDays(today, -470) }))
      .rejects.toMatchObject({ status: 400 });
    await expect(save({ period_start: fc.addDays(today, 120), period_end: fc.addDays(today, 150) }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('someone who sees one plant cannot change the company\'s bill', async () => {
    const supervisor = { company_id: 4, plant_id: 2, roles: ['SUPERVISOR'] };
    await expect(save({ period_start: today, period_end: fc.addDays(today, 29) }, supervisor)).rejects.toMatchObject({ status: 403 });
    await expect(readScope.run(supervisor, () => svc.clearBillPeriod({ company_id: 4 }))).rejects.toMatchObject({ status: 403 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('removed: the forecast goes back to asking for them', async () => {
    const r = await svc.clearBillPeriod({ company_id: 4 });
    expect(mockDb.calls()[0]).toMatchObject({ text: 'DELETE FROM energy_billing WHERE company_id = $1', params: [4] });
    expect(r).toMatchObject({ configured: false, current: null });
  });
});
