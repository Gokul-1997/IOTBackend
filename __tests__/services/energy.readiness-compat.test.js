jest.mock('../../src/db', () => ({ query: jest.fn() }));
const db = require('../../src/db');
const store = require('../../src/dashboard/energy-store');
const machine = require('../../src/dashboard/dashboard.service');
const meter = require('../../src/dashboard/energy-meter.service');
const maintenance = require('../../src/dashboard/maintenance.service');
const scope = require('../../src/lib/read-scope');

const NOW = Date.parse('2026-11-02T12:00:00+05:30');
const missing = () => Object.assign(new Error('relation "energy_pipeline_state" does not exist'), { code: '42P01' });
const savedFlag = process.env.ENERGY_V2_ENABLED;
let warning;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  process.env.ENERGY_V2_ENABLED = 'true';
  store.invalidate();
  db.query.mockReset();
  warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warning.mockRestore();
  if (savedFlag === undefined) delete process.env.ENERGY_V2_ENABLED;
  else process.env.ENERGY_V2_ENABLED = savedFlag;
  jest.useRealTimers();
});

test('missing migration 064 stays on the current source, bounds warnings and discovers a later migration', async () => {
  db.query.mockRejectedValue(missing());
  expect(await store.enabled(4)).toBe(false);
  expect(await store.enabled(4)).toBe(false);
  expect(await store.enabled(5)).toBe(false);
  expect(db.query.mock.calls.map(([, params]) => params)).toEqual([[4], [5]]);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0][0]).toContain('migration 064');
  jest.advanceTimersByTime(5001);
  expect(await store.enabled(4)).toBe(false);
  expect(warning).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(60_000);
  expect(await store.enabled(4)).toBe(false);
  expect(warning).toHaveBeenCalledTimes(2);
  db.query.mockResolvedValue({ rows: [{ ready: true }] });
  jest.advanceTimersByTime(5001);
  expect(await store.enabled(4)).toBe(true);
});

test.each([
  { code: '42501', message: 'permission denied for table energy_pipeline_state' },
  { code: '08006', message: 'connection lost' },
  { code: '57014', message: 'canceling statement due to statement timeout' },
  { code: '42P01', message: 'relation "different_relation" does not exist' }
])('readiness never hides a different database failure: $code / $message', async ({ code, message }) => {
  const error = Object.assign(new Error(message), { code });
  db.query.mockRejectedValue(error);
  await expect(store.enabled(4)).rejects.toBe(error);
  await expect(store.enabled(4)).rejects.toBe(error);
  expect(db.query).toHaveBeenCalledTimes(2);
});

function beforeMigration() {
  db.query.mockImplementation(async sql => {
    if (/SELECT ready FROM energy_pipeline_state/.test(sql)) throw missing();
    if (/energy_pipeline_state|energy_meter_latest|energy_counter_|energy_electrical_1m/.test(sql)) {
      throw new Error('An uninstalled v2 table was queried after readiness returned false');
    }
    if (/SELECT\s+id,\s*machine_serial_no/.test(sql)) {
      return { rows: [{ id: 15, machine_serial_no: 'VMC-1-F', image_url: null }] };
    }
    if (/SELECT m.id, m.machine_serial_no, latest.read_at AS last_read_at/.test(sql)) {
      return { rows: [{ id: 15, machine_serial_no: 'VMC-1-F', last_read_at: new Date(NOW - 1000) }] };
    }
    if (/WITH latest_at AS MATERIALIZED/.test(sql)) {
      return { rows: [{ field_values: { v1n: 230 }, field_observed_at: { v1n: NOW - 1000 } }] };
    }
    return { rows: [] };
  });
}

test('machine detail still opens when the feature flag precedes migration 064', async () => {
  beforeMigration();
  const result = await machine.machineDetail(null, 15, 4);
  expect(result.machine.id).toBe(15);
  expect(db.query.mock.calls.filter(([sql]) => /SELECT ready FROM energy_pipeline_state/.test(sql)))
    .toHaveLength(1);
});

test('meter latest fields stay on installed tables and retain company/plant scope before migration 064', async () => {
  beforeMigration();
  const result = await scope.run({ company_id: 4, plant_id: 11, roles: ['USER'] },
    () => meter.meterReadings({ companyId: 4, machineId: 15, nowMs: NOW }));
  expect(result.machine.id).toBe(15);
  expect(result.latest.v1n).toBe(230);
  const [sql, params] = db.query.mock.calls.find(([text]) => /WITH latest_at AS MATERIALIZED/.test(text));
  expect(sql).not.toMatch(/energy_pipeline_state|energy_meter_latest/);
  expect(sql).toContain('r.company_id = $4');
  expect(sql).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 11');
  expect(params[0]).toBe(15);
  expect(params[3]).toBe(4);
});

test('maintenance supply retains actual phases and tenant scope before migration 064', async () => {
  beforeMigration();
  const result = await scope.run({ company_id: 4, plant_id: 11, roles: ['USER'] },
    () => maintenance.getMaintenanceDashboard({ user: { company_id: 4 }, query: { date: '2026-11-02', machine_id: '15' } }));
  expect(result.supply.ln.v1n).toBe(230);
  const [sql, params] = db.query.mock.calls.find(([text]) => /WITH latest_at AS MATERIALIZED/.test(text));
  expect(sql).not.toMatch(/energy_pipeline_state|energy_meter_latest/);
  expect(sql).toContain('r.company_id = $1');
  expect(sql).toContain('authorized_machine.company_id = 4 AND authorized_machine.plant_id = 11');
  expect(params[0]).toBe(4);
  expect(params[3]).toBe(15);
});
