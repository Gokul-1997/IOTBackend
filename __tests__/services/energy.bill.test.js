/*
 * The EB bill: service connections, their bills as printed, EB meter
 * readings, and the forecast the Energy Dashboard shows
 * (dashboard/energy-bill.service.js). The arithmetic has its own tests
 * (energy.forecast.test.js); these are about what is read and refused, and
 * that an estimate is never shown as a measurement.
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
const NOW = at('2026-10-23', 12);
const supervisor = { company_id: 4, plant_id: 2, roles: ['SUPERVISOR'] };

/* S AND T's July–August bills, as the database gives them back. */
const bill1212 = { id: 11, connection_id: 1, from: '2026-07-26', to: '2026-08-26', units: '55952.00', rate: '8.1300',
  electricity_charges: '455093.00', peak_charges: '0.00', fixed_charges: '91200.00', penalty_charges: '16372.00',
  welding_charges: '68264.00', tax_charges: '29512.00', other_charges: '0.00', net_amount: '660441.00' };
const bill2309 = { id: 12, connection_id: 2, from: '2026-07-26', to: '2026-08-27', units: '68988.00', rate: '8.2500',
  electricity_charges: '569151.00', peak_charges: '0.00', fixed_charges: '89984.00', penalty_charges: '15593.00',
  welding_charges: '0.00', tax_charges: '32622.00', other_charges: '0.00', net_amount: '707350.00' };
const conns = { rows: [{ id: 1, sc_number: '1212', name: null, meter_machine_id: null, meter_machine: null },
                       { id: 2, sc_number: '2309', name: 'Plant 2', meter_machine_id: null, meter_machine: null }] };

beforeEach(() => {
  resetDb();
  hourly.hours.mockReset();
  hourly.kick.mockReset();
});

describe('the forecast', () => {
  test('no bill entered yet: says so, and reads no meter history', async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [] }, { rows: [] });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r).toMatchObject({ configured: false, connections: [], total: null });
    expect(hourly.hours).not.toHaveBeenCalled();
  });

  test('from the last bills only: each supply\'s bill on its own reading dates, an estimate, and their total', async () => {
    mockDb.queueResponse(conns, { rows: [bill2309, bill1212] }, { rows: [] });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    const [a, b] = r.connections;
    expect(a).toMatchObject({ sc_number: '1212', status: 'ok', source: 'bills', cycle: 'Every month',
      period: { start: '2026-09-26', end: '2026-10-26', days: 30, day: 28 } });
    expect(a.units.measured).toBe(false);
    expect(a.units.total).toBe(Math.round(55952 / 31 * 30));
    // worked out as the bill is: units × the rate it really charged, the rest in proportion, fixed as billed
    const expected = fc.chargesFor(55952 / 31 * 30, fc.tariffOf({ ...bill1212 }));
    expect(a.forecast).toEqual(expected);
    expect(a.forecast.fixed_charges).toBe(91200);
    expect(a.tariff).toMatchObject({ printed_rate: 8.13, welding_pct: 15, fixed_charges: 91200 });
    expect(a.last_bill).toMatchObject({ from: '2026-07-26', to: '2026-08-26', units: 55952, net_amount: 660441 });

    expect(b).toMatchObject({ sc_number: '2309', name: 'Plant 2', period: { start: '2026-09-27', end: '2026-10-27' } });
    expect(r.total).toMatchObject({
      net_amount: a.forecast.net_amount + b.forecast.net_amount,
      last_net: 660441 + 707350, measured: false, ends: '2026-10-27'
    });
    expect(hourly.hours).not.toHaveBeenCalled();
  });

  test('EB meter readings this bill: the units so far are measured, to the day of the last reading', async () => {
    mockDb.queueResponse({ rows: [conns.rows[0]] }, { rows: [bill1212] }, { rows: [
      { id: 1, connection_id: 1, read_on: '2026-09-26', kwh: '100000.00' },
      { id: 2, connection_id: 1, read_on: '2026-10-14', kwh: '132000.00' },
      { id: 3, connection_id: 1, read_on: '2026-10-21', kwh: '144600.00' }] });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r.connections[0]).toMatchObject({ source: 'readings', units: { so_far: 44600, as_of: '2026-10-21', measured: true } });
    expect(r.total.measured).toBe(true);
  });

  test('a meter on the supply: its hours, when they cover the bill; else the last bills', async () => {
    const withMeter = { rows: [{ ...conns.rows[0], meter_machine_id: 7, meter_machine: 'EB incomer' }] };
    const rows = [];
    // 75 kWh every hour up to now (the hour just begun has nothing in it yet)
    for (let h = fc.istHour(at('2026-09-01')); h < fc.istHour(NOW); h += H) rows.push({ machine_id: 7, hour: h, kwh: 75, readings: 240 });
    mockDb.queueResponse(withMeter, { rows: [bill1212] }, { rows: [] });
    hourly.hours.mockResolvedValue({ rows, completeFrom: at('2026-09-01') });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r.connections[0]).toMatchObject({ source: 'meter', meter: { machine_id: 7, machine: 'EB incomer' } });
    expect(r.connections[0].units.total).toBe(75 * 24 * 30);

    // its history not worked out back to this bill's start yet: the bills, and the history is caught up
    mockDb.queueResponse(withMeter, { rows: [bill1212] }, { rows: [] });
    hourly.hours.mockResolvedValue({ rows, completeFrom: at('2026-10-10') });
    const later = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(later.connections[0].source).toBe('bills');
    expect(hourly.kick).toHaveBeenCalledWith(4);
  });

  test('a supply with no bill yet is listed as needing one, and left out of the total', async () => {
    mockDb.queueResponse(conns, { rows: [bill1212] }, { rows: [] });
    const r = await svc.getBill({ company_id: 4 }, { now: NOW });
    expect(r.connections[1]).toMatchObject({ sc_number: '2309', status: 'no_bill' });
    expect(r.total.net_amount).toBe(r.connections[0].forecast.net_amount);
  });

  test('the bill is the whole company\'s: someone who sees one plant does not get it', async () => {
    const r = await readScope.run(supervisor, () => svc.getBill({ company_id: 4 }, { now: NOW }));
    expect(r).toMatchObject({ restricted: true, configured: false });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('service connections', () => {
  test('added with the number as on the bill; the same number twice is refused', async () => {
    mockDb.queueResponse({ rows: [{ id: 3 }] });
    expect(await svc.saveConnection({ company_id: 4, sc_number: ' 1212 ', name: '', user_id: 9 })).toEqual({ id: 3 });
    expect(mockDb.calls()[0].params).toEqual([4, '1212', null, null, 9]);

    mockDb.queueError(Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(svc.saveConnection({ company_id: 4, sc_number: '1212' })).rejects.toMatchObject({ status: 409, message: 'Service connection 1212 is already added' });
  });

  test('refused: no number, another company\'s machine as the meter, another company\'s connection', async () => {
    await expect(svc.saveConnection({ company_id: 4, sc_number: '  ' })).rejects.toMatchObject({ status: 400 });
    mockDb.queueResponse({ rows: [] });
    await expect(svc.saveConnection({ company_id: 4, sc_number: '1212', meter_machine_id: 99 })).rejects.toMatchObject({ status: 400 });
    mockDb.queueResponse({ rows: [] });
    await expect(svc.saveConnection({ company_id: 4, id: 55, sc_number: '1212' })).rejects.toMatchObject({ status: 404 });
    await expect(readScope.run(supervisor, () => svc.saveConnection({ company_id: 4, sc_number: '1' }))).rejects.toMatchObject({ status: 403 });
  });
});

describe('bills as printed', () => {
  const body = { from: '2026-07-26', to: '2026-08-26', units: 55952, rate: 8.13, peak_charges: 0, electricity_charges: 455093,
    fixed_charges: 91200, penalty_charges: 16372, welding_charges: 68264, tax_charges: 29512, net_amount: 660441 };
  const save = (b, extra = {}) => svc.saveBill({ company_id: 4, connection_id: 1, body: b, user_id: 9, ...extra });

  test('saved as typed, with how far the rounded rate is from the charges, and that the charges add up', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] }, { rows: [] }, { rows: [bill1212] });
    const r = await save(body);
    expect(r.checks).toEqual({ rate_difference: 203.24, net_difference: 0 });
    expect(r.bill).toMatchObject({ from: '2026-07-26', to: '2026-08-26', days: 31, units: 55952, net_amount: 660441 });
    const insert = mockDb.calls()[2];
    expect(insert.text).toMatch(/INSERT INTO energy_bills/);
    expect(insert.params.slice(0, 4)).toEqual([1, 4, '2026-07-26', '2026-08-26']);
  });

  test('left blank: electricity charges are units × rate, the net is the charges added', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] }, { rows: [] }, { rows: [bill2309] });
    await save({ from: '2026-07-26', to: '2026-08-27', units: 68988, rate: 8.25, fixed_charges: 89984, penalty_charges: 15593, tax_charges: 32622 });
    const p = mockDb.calls()[2].params;
    expect(p[6]).toBe(569151);                                // electricity charges
    expect(p[13]).toBe(569151 + 89984 + 15593 + 32622);       // net
  });

  test.each([
    [{ from: '', to: '2026-08-26' }, /From and To/],
    [{ from: '2026-08-26', to: '2026-08-26' }, /after the From/],
    [{ from: '2026-01-01', to: '2026-08-26' }, /at most 3 months/],
    [{ from: '2099-07-26', to: '2099-08-26' }, /future/],
    [{ units: 0 }, /more than 0/],
    [{ units: 'lots' }, /must be a number/],
    [{ electricity_charges: '', rate: '' }, /electricity charges, or the rate/],
    [{ fixed_charges: -5 }, /0 or more/]
  ])('refused before anything is saved: %p', async (change, message) => {
    mockDb.queueResponse({ rows: [{ id: 1 }] });
    await expect(save({ ...body, ...change })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(mockDb.calls().filter(c => /INSERT|UPDATE/.test(c.text))).toHaveLength(0);
  });

  test('dates overlapping another bill of the supply are refused', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] }, { rows: [{ f: '26 Jul 2026', t: '26 Aug 2026' }] });
    await expect(save({ ...body, from: '2026-08-10', to: '2026-09-10' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/overlap the bill of 26 Jul 2026/) });
  });

  test('another company\'s connection: not found, nothing saved', async () => {
    mockDb.queueResponse({ rows: [] });
    await expect(save(body)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()).toHaveLength(1);
  });
});

describe('EB meter readings', () => {
  const save = b => svc.saveReading({ company_id: 4, connection_id: 1, body: b, user_id: 9 });

  test('saved for the day; the same day again replaces it', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] }, { rows: [] }, { rows: [{ id: 5, read_on: '2026-10-21', kwh: '144600.00' }] });
    expect(await save({ read_on: '2026-10-21', kwh: 144600 })).toEqual({ id: 5, read_on: '2026-10-21', kwh: 144600 });
    expect(mockDb.calls()[2].text).toMatch(/ON CONFLICT \(connection_id, read_on\) DO UPDATE/);
  });

  test('a register only climbs: lower than the day before, or higher than the day after, is a typing slip', async () => {
    mockDb.queueResponse({ rows: [{ id: 1 }] }, { rows: [{ d: '20 Oct 2026', kwh: '143000.00', side: 'before' }] });
    await expect(save({ read_on: '2026-10-21', kwh: 14460 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/20 Oct 2026 was 143000: this one cannot be lower/) });
    mockDb.queueResponse({ rows: [{ id: 1 }] }, { rows: [{ d: '22 Oct 2026', kwh: '146000.00', side: 'after' }] });
    await expect(save({ read_on: '2026-10-21', kwh: 1446000 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/cannot be higher/) });
    mockDb.queueResponse({ rows: [{ id: 1 }] });
    await expect(save({ read_on: '2099-01-01', kwh: 1 })).rejects.toMatchObject({ status: 400 });
  });
});
