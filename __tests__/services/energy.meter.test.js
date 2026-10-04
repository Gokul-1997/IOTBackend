/*
 * The energy meter's own readings (energy_meter_readings, migration 029).
 * What matters: only this company's machines, only the chosen window, a
 * dropped read or a misread never counts as energy used, and a meter wired
 * the wrong way round is said so in plain words rather than "corrected".
 *
 * The same queries were run against a real PostgreSQL with 26 hours of
 * VMC - 1 - F-like readings (one 0, one 5.4 × 10^15 misread): 24 h read
 * 23.98 kWh used at 1 kWh an hour.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/energy-meter.service');

const NOW = Date.parse('2026-10-04T11:30:00+05:30');
const meterRow = { id: 15, machine_serial_no: 'VMC - 1 - F', last_read_at: new Date(NOW - 10e3) };

/* VMC - 1 - F's reading of 3 Oct 2026: negative kW and power factor, more Export than Import */
const reading = (over = {}) => ({
  machine_id: 15, company_id: 4, read_at: new Date(NOW - 10e3),
  ...Object.fromEntries(svc.READING_COLUMNS.map(c => [c, 1])),
  v_ll_avg: 416.73, i_avg: 1.244, kw_total: -0.73, pf_avg: -0.836, frequency_hz: 49.958,
  kwh_import: 33.1, kwh_export: 77.5, kwh_total: 110.8, aux_interrupts: 5,
  ...over
});

/* call order: meters list, [machine check], latest, points, energy steps, summary */
function given({ meters = [meterRow], machine = null, latest = [reading()], points = [], energy = [], summary = {} } = {}) {
  mockDb.queueResponse({ rows: meters });
  if (machine) mockDb.queueResponse({ rows: machine });
  mockDb.queueResponse({ rows: latest }, { rows: points }, { rows: energy }, { rows: [summary] });
}

const callMatching = re => mockDb.calls().find(c => re.test(c.text));

beforeEach(() => resetDb());

describe('meterReadings — input and tenancy', () => {
  test('a bad range or machine id is a 400 before any query', async () => {
    await expect(svc.meterReadings({ companyId: 4, range: '2h', nowMs: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(svc.meterReadings({ companyId: 4, machineId: 'x', nowMs: NOW })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test("another company's machine is not found, and its readings are never read", async () => {
    mockDb.queueResponse({ rows: [] }, { rows: [] });
    expect(await svc.meterReadings({ companyId: 99, machineId: 15, nowMs: NOW })).toBeNull();
    expect(mockDb.calls()).toHaveLength(2);
    expect(mockDb.calls()[1].params).toEqual([15, 99]);
  });

  test('the meter list is this company\'s machines, read within 30 days', async () => {
    given();
    await svc.meterReadings({ companyId: 4, nowMs: NOW });
    const q = mockDb.calls()[0];
    expect(q.text).toMatch(/JOIN machines m ON m.id = r.machine_id/);
    expect(q.text).toMatch(/WHERE m.company_id = \$1 AND r.read_at >= \$2/);
    expect(q.params).toEqual([4, new Date(NOW - 30 * 86400e3)]);
  });

  test('with no machine named, the first machine with a meter is shown', async () => {
    given();
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d.machine).toEqual({ id: 15, serial: 'VMC - 1 - F' });
    expect(d.meters).toEqual([{ id: 15, serial: 'VMC - 1 - F', last_read_at: NOW - 10e3 }]);
  });

  test('before migration 029 has run, the answer is "no meter yet", not an error', async () => {
    mockDb.queueError(Object.assign(new Error('relation "energy_meter_readings" does not exist'), { code: '42P01' }));
    const d = await svc.meterReadings({ companyId: 4, machineId: 15, nowMs: NOW });
    expect(d).toMatchObject({ meters: [], machine: null, latest: null, points: [] });
    expect(mockDb.calls()).toHaveLength(1);
  });

  test('any other database failure is not hidden', async () => {
    mockDb.queueError(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(svc.meterReadings({ companyId: 4, nowMs: NOW })).rejects.toThrow('connection reset');
  });

  test('a company with no meter gets an empty answer and nothing more is read', async () => {
    mockDb.queueResponse({ rows: [] });
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d).toMatchObject({ meters: [], machine: null, latest: null, points: [], summary: { readings: 0 } });
    expect(mockDb.calls()).toHaveLength(1);
  });
});

describe('meterReadings — the window', () => {
  test('every read is this machine, bounded to the range; the latest within 30 days', async () => {
    given({ machine: [{ id: 15, machine_serial_no: 'VMC - 1 - F' }] });
    const d = await svc.meterReadings({ companyId: 4, machineId: 15, range: '4h', nowMs: NOW });
    expect(d.range).toEqual({ key: '4h', from: NOW - 4 * 3600e3, to: NOW, bucket_seconds: 300 });
    const latest = callMatching(/ORDER BY read_at DESC LIMIT 1/);
    expect(latest.params).toEqual([15, new Date(NOW - 30 * 86400e3), new Date(NOW)]);
    const points = callMatching(/AS kw_avg,\s+MIN\(kw_total\)/);
    expect(points.params).toEqual([15, new Date(NOW - 4 * 3600e3), new Date(NOW), '300 seconds']);
    expect(points.text).toMatch(/date_bin\(\$4::interval, read_at/);
  });

  test.each([['1h', 60], ['4h', 300], ['12h', 900], ['24h', 1800], ['7d', 10800]])(
    '%s is bucketed to %i-second points', async (range, bucket) => {
      given();
      const d = await svc.meterReadings({ companyId: 4, range, nowMs: NOW });
      expect(d.range.bucket_seconds).toBe(bucket);
    });
});

describe('meterReadings — energy used', () => {
  test('a 0 is a dropped read, a fall counts nothing, and a rise no machine could draw is a misread', async () => {
    given();
    await svc.meterReadings({ companyId: 4, nowMs: NOW });
    const q = callMatching(/WITH steps AS/);
    expect(q.text).toMatch(/AND kwh_total > 0/);
    expect(q.text).toMatch(/WHEN prev_kwh IS NULL OR kwh_total <= prev_kwh THEN 0/);
    expect(q.text).toMatch(/kwh_total - prev_kwh\s+> 2000 \* GREATEST\(EXTRACT\(EPOCH FROM read_at - prev_at\), 300\) \/ 3600\.0 THEN 0/);
  });

  test('the range\'s energy is the sum of its intervals, and each point carries its own', async () => {
    given({
      points: [{ t: '1791093360000', samples: 4, kw_avg: -0.8 }, { t: '1791093420000', samples: 4, kw_avg: -0.7 }],
      energy: [{ t: '1791093360000', kwh: 0.0167 }, { t: '1791093420000', kwh: 0.0166 }],
      summary: { readings: 8 }
    });
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d.summary.kwh_used).toBeCloseTo(0.0333, 4);
    expect(d.points.map(p => p.kwh)).toEqual([0.0167, 0.0166]);
    expect(d.points[0].t).toBe(1791093360000);
  });

  test('no running total in the range is unknown energy, not zero', async () => {
    given({ summary: { readings: 4 } });
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d.summary.kwh_used).toBeNull();
  });

  test('import, export, kVArh and kVAh are the rise from first to last; a fall is unknown', async () => {
    given({ summary: { readings: 100,
      kwh_import_first: 33.1, kwh_import_last: 33.1,
      kwh_export_first: 77.5, kwh_export_last: 101.5,
      kvarh_first: 107.9, kvarh_last: 2,          // reset meter
      kvah_first: null, kvah_last: null } });
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d.summary.kwh_import).toBe(0);
    expect(d.summary.kwh_export).toBe(24);
    expect(d.summary.kvarh).toBeNull();
    expect(d.summary.kvah).toBeNull();
  });
});

describe('meterReadings — the latest reading', () => {
  test('every value as the meter sent it, with when it was taken', async () => {
    given();
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d.latest).toMatchObject({ at: NOW - 10e3, stale: false, v_ll_avg: 416.73, kw_total: -0.73, pf_avg: -0.836, kwh_total: 110.8, aux_interrupts: 5 });
    expect(Object.keys(d.latest)).toEqual(['at', 'stale', ...svc.READING_COLUMNS]);
  });

  test('a reading over two minutes old is not "now"', async () => {
    given({ latest: [reading({ read_at: new Date(NOW - 121e3) })] });
    expect((await svc.meterReadings({ companyId: 4, nowMs: NOW })).latest.stale).toBe(true);
  });

  test('no reading at all is null', async () => {
    given({ latest: [] });
    const d = await svc.meterReadings({ companyId: 4, nowMs: NOW });
    expect(d.latest).toBeNull();
    expect(d.checks.ct_reversed).toBe(false);
  });
});

describe('meterReadings — checks on the meter', () => {
  test('negative kW and more Export than Import: the CTs face the wrong way', async () => {
    given();
    expect((await svc.meterReadings({ companyId: 4, nowMs: NOW })).checks.ct_reversed).toBe(true);
  });

  test('a correctly wired meter is not flagged', async () => {
    given({ latest: [reading({ kw_total: 7.2, pf_avg: 0.92, kwh_import: 120, kwh_export: 0.4 })] });
    expect((await svc.meterReadings({ companyId: 4, nowMs: NOW })).checks.ct_reversed).toBe(false);
  });

  test('a short regenerative moment alone is not a wiring fault', async () => {
    // negative kW for a moment, but Import still far ahead of Export
    given({ latest: [reading({ kw_total: -0.4, pf_avg: 0.9, kwh_import: 500, kwh_export: 3 })] });
    expect((await svc.meterReadings({ companyId: 4, nowMs: NOW })).checks.ct_reversed).toBe(false);
  });

  test('the guidance the screen colours by travels with the data', async () => {
    given();
    expect((await svc.meterReadings({ companyId: 4, nowMs: NOW })).limits)
      .toMatchObject({ v_ll_nominal: 415, v_tolerance_pct: 10, pf_low: 0.9, hz_min: 49.5, hz_max: 50.5 });
  });
});

test('every query binds exactly the parameters it references', async () => {
  given({ machine: [{ id: 15, machine_serial_no: 'VMC - 1 - F' }] });
  await svc.meterReadings({ companyId: 4, machineId: 15, nowMs: NOW });
  for (const { text, params } of mockDb.calls()) {
    const refs = [...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    expect(params.length).toBe(refs.length ? Math.max(...refs) : 0);
  }
});
