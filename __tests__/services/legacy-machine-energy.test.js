jest.mock('../../src/db', () => ({ query: jest.fn() }));
const db = require('../../src/db');
const { SQL, getLegacyMachineEnergy } = require('../../src/dashboard/legacy-machine-energy');

beforeEach(() => db.query.mockReset());

test('uses one parameterized query and preserves measured and unknown values', async () => {
  const row = { total_energy: 3104, shift_kwh: null, accepted_intervals: '0', rejected_intervals: '0' };
  db.query.mockResolvedValue({ rows: [row] });
  const input = { companyId: 4, machineId: 15, start: new Date('2026-11-02T02:30:00Z'),
    end: new Date('2026-11-02T14:30:00Z'), asOf: new Date('2026-11-02T10:00:00Z') };
  expect(await getLegacyMachineEnergy(input)).toBe(row);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(db.query).toHaveBeenCalledWith(SQL, [15, input.start, input.end, 4, input.asOf]);
});

test('supports no current shift without inventing zero consumption', async () => {
  db.query.mockResolvedValue({ rows: [{ total_energy: 10, shift_kwh: null }] });
  expect(await getLegacyMachineEnergy({ companyId: 4, machineId: 15, start: null, end: null,
    asOf: new Date('2026-11-02T10:00:00Z') })).toEqual({ total_energy: 10, shift_kwh: null });
  expect(db.query.mock.calls[0][1].slice(1, 3)).toEqual([null, null]);
});

test('reads standalone claims once and filters raw counters before source suppression', () => {
  expect(SQL).toMatch(/claimed AS MATERIALIZED/);
  expect(SQL).toMatch(/r\.standalone AND r\.kwh_total IS NOT NULL/);
  expect(SQL).toMatch(/t\.energy > 0 AND t\.energy < 'Infinity'::float8/);
  expect(SQL).toMatch(/NOT EXISTS \([\s\S]*FROM claimed r WHERE r\.read_at = to_timestamp\(t\.device_time\)/);
  expect(SQL).not.toMatch(/JOIN energy_meter_readings/);
});

test('preserves event-time ordering, source bounds and valid cumulative counters', () => {
  expect(SQL).toMatch(/ORDER BY observed_at DESC, t\.received_at DESC LIMIT 1/);
  expect(SQL).toMatch(/ORDER BY observed_at DESC, received_at DESC LIMIT 1/);
  expect(SQL).toContain("t.received_at >= $5::timestamptz - INTERVAL '30 days'");
  expect(SQL).toContain("COALESCE(to_timestamp(t.device_time), t.received_at) >= $5::timestamptz - INTERVAL '30 days'");
  expect(SQL).toContain('t.received_at <= $5::timestamptz');
  expect(SQL).toContain('COALESCE(to_timestamp(t.device_time), t.received_at) <= $5::timestamptz');
  expect(SQL).toMatch(/r\.company_id = \$4 AND r\.machine_id = \$1 AND r\.standalone/);
});

test('preserves the current shift guards and database failures', async () => {
  expect(SQL).toContain('LAG(energy) OVER w AS prev_energy');
  expect(SQL).toContain('WHEN prev_energy IS NULL OR energy < prev_energy THEN NULL');
  expect(SQL).toContain('GREATEST(EXTRACT(EPOCH FROM observed_at - prev_at), 300)');
  const failure = new Error('database unavailable');
  db.query.mockRejectedValue(failure);
  await expect(getLegacyMachineEnergy({ companyId: 4, machineId: 15 })).rejects.toBe(failure);
});
