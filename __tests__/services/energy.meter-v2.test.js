jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
jest.mock('../../src/dashboard/energy-store', () => ({ enabled: jest.fn(), meterEnergy: jest.fn() }));
const { mockDb, resetDb } = require('../helpers/mockDb');
const energyStore = require('../../src/dashboard/energy-store');
const service = require('../../src/dashboard/energy-meter.service');
const scope = require('../../src/lib/read-scope');

const NOW = Date.parse('2026-10-30T10:42:12.333+05:30');
const savedFlag = process.env.ENERGY_V2_ENABLED;
beforeEach(() => {
  resetDb();
  process.env.ENERGY_V2_ENABLED = 'true';
  energyStore.enabled.mockResolvedValue(true);
  energyStore.meterEnergy.mockResolvedValue([]);
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ENERGY_V2_ENABLED;
  else process.env.ENERGY_V2_ENABLED = savedFlag;
});
function given({ latest = [], points = [], summary = {}, energy = [] } = {}) {
  mockDb.queueResponse(
    { rows: [{ id: 15, machine_serial_no: 'VMC - 1 - F', last_read_at: new Date(NOW - 1000) }] },
    { rows: latest }, { rows: [{ points, summary }] }
  );
  energyStore.meterEnergy.mockResolvedValue(energy);
}

test('ready meter reads the latest projection and minute aggregates, with bounded raw edges', async () => {
  given();
  await service.meterReadings({ companyId: 4, range: '7d', nowMs: NOW });
  const calls = mockDb.calls();
  expect(calls).toHaveLength(3);
  expect(calls[0].text).toContain('JOIN energy_meter_latest l');
  expect(calls[0].text).not.toContain('energy_meter_readings');
  expect(calls[1].text).toContain('FROM energy_meter_latest l');
  expect(calls[1].text).toContain('AND NOT (SELECT ready FROM readiness)');
  const electrical = calls[2];
  expect(electrical.text).toContain('FROM energy_electrical_1m e');
  expect(electrical.text).toContain('AND (r.read_at<b.full_from OR r.read_at>=b.full_to OR EXISTS(');
  expect(electrical.text).toContain('q.from_at<e.bucket+INTERVAL \'1 minute\' AND q.through_at>=e.bucket');
  expect(electrical.text).toContain('SUM(kw_total_sum)/NULLIF(SUM(kw_total_count),0) AS kw_avg');
  expect(electrical.text).not.toMatch(/AVG\([^)]*_avg\)/);
  expect(electrical.params).toEqual([15, new Date(NOW - 7 * 86400e3), new Date(NOW), '10800 seconds', 4]);
  expect(energyStore.meterEnergy).toHaveBeenCalledWith({ companyId: 4, machineId: 15,
    start: new Date(NOW - 7 * 86400e3), end: new Date(NOW), bucketSeconds: 10800 });
  expect(calls.every(call => !/LAG\(/.test(call.text))).toBe(true);
});

test('canonical interval totals retain unknown registers and incomplete coverage', async () => {
  given({ points: [{ t: NOW - 1000, samples: 2, kw_avg: 7.5 }], summary: { readings: 2, kw_avg: 7.5 },
    energy: [{ t: NOW - 1000, kwh: 0.75, kwh_import: 0, kwh_export: null, kvarh: null, kvah: null,
      energy_intervals: 2, energy_rejected_intervals: 1, energy_complete: false }] });
  const result = await service.meterReadings({ companyId: 4, nowMs: NOW });
  expect(result.summary).toMatchObject({ kwh_used: 0.75, kwh_import: 0, kwh_export: null,
    energy_intervals: 2, energy_rejected_intervals: 1, energy_complete: false,
    energy_source: 'canonical_energy_intervals', average_basis: 'reported_samples' });
  expect(result.points[0]).toMatchObject({ kwh: 0.75, kw_avg: 7.5 });
});

test('a measured flat interval is zero, while no measured interval is unknown', async () => {
  given({ energy: [{ t: NOW, kwh: 0, energy_intervals: 1, energy_rejected_intervals: 0, energy_complete: true }] });
  const result = await service.meterReadings({ companyId: 4, nowMs: NOW });
  expect(result.summary).toMatchObject({ kwh_used: 0, energy_complete: true });
  resetDb();
  given();
  expect((await service.meterReadings({ companyId: 4, nowMs: NOW })).summary)
    .toMatchObject({ kwh_used: null, energy_complete: false });
});

test('every v2 query retains tenant and plant scope', async () => {
  given();
  await scope.run({ company_id: 4, plant_id: 11, roles: ['USER'] },
    () => service.meterReadings({ companyId: 4, nowMs: NOW }));
  for (const call of mockDb.calls()) {
    expect(call.text).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 11');
    expect(call.text).toMatch(/company_id\s*=\s*\$[145]/);
    const maxBind = Math.max(...[...call.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
    expect(call.params).toHaveLength(maxBind);
  }
});

test('latest projection bounds each requested channel and supports an explicit legacy seed scan', () => {
  const sql = service.latestMeterFieldsSQL(['v1n', 'v12'], { activeOnly: true, upperExclusive: true });
  expect(sql).toContain('AND m.is_active');
  expect(sql).toContain("('v1n', (l.field_observed_at ->> 'v1n')::double precision)");
  expect(sql).toContain('field.at < EXTRACT(EPOCH FROM $3::timestamptz) * 1000');
  expect(sql).toContain('field.at <= EXTRACT(EPOCH FROM NOW()) * 1000');
  const legacy = service.latestMeterFieldsSQL(['v1n'], { legacyOnly: true });
  expect(legacy).toContain('FROM energy_meter_readings r');
  expect(legacy).not.toContain('energy_pipeline_state');
  expect(legacy).not.toContain('energy_meter_latest');
});

test('future observations are absent measurements, including when another channel is current', () => {
  const latest = service.latestMeterSnapshot({ field_values: { v1n: 230, kwh_total: 22 },
    field_observed_at: { v1n: NOW - 1000, kwh_total: NOW + 1000 } }, ['v1n','kwh_total'], NOW);
  expect(latest).toMatchObject({ at: NOW - 1000, v1n: 230, kwh_total: null,
    field_observed_at: { v1n: NOW - 1000, kwh_total: null } });
});

test('SQL field names are validated before building projection or legacy queries', () => {
  expect(() => service.latestMeterFieldsSQL(['v1n); DROP TABLE machines; --'])).toThrow('Invalid meter fields');
  expect(() => service.latestMeterFieldsSQL([])).toThrow('Invalid meter fields');
});
