const answers = [];
const calls = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text, params) => {
    calls.push({ text, params });
    const hit = answers.find(([re]) => re.test(text));
    return { rows: hit ? hit[1] : [] };
  })
}));

const svc = require('../../src/dashboard/dashboard.service');
const ENERGY = /WITH readings AS \([\s\S]+FROM energy_observations/;

function given({ measurement = {}, statusEnergy = null, online = true, shift = true } = {}) {
  answers.length = 0;
  calls.length = 0;
  answers.push(
    [/FROM machines\s+WHERE id = \$1 AND company_id = \$2/,
      [{ id: 25, machine_serial_no: 'HMC - 7 - F', image_url: null }]],
    [/FROM shifts/, shift ? [{ id: 6, shift_code: 'DAY', start_time: '08:00:00', end_time: '20:00:00' }] : []],
    [ENERGY, [measurement]],
    [/FROM telemetry_raw\s+WHERE machine_id = \$1\s+AND company_id = \$2/,
      [{ machine_status: 'RUNNING', received_at: new Date(Date.now() - (online ? 1000 : 7200000)),
        alarm: false, energy: statusEnergy }]]
  );
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-10-29T12:00:00+05:30'));
});
afterEach(() => jest.useRealTimers());

test('a sparse status update cannot clear the independently received energy counter', async () => {
  given({ measurement: { total_energy: '3104', shift_kwh: '1.25', accepted_intervals: '2', rejected_intervals: '0' } });
  const d = await svc.machineDetail(null, 25, 4);
  expect(d.live.machine_status).toBe('RUNNING');
  expect(d.live.total_energy).toBe(3104);
  expect(d.power).toEqual({ total_kwh: 3104, shift_kwh: 1.25, energy_complete: true, rejected_intervals: 0 });
});

test('a meter-only update takes precedence over an older machine-status counter', async () => {
  given({ statusEnergy: 3000, measurement: { total_energy: '3104.12345', shift_kwh: '0', accepted_intervals: '1' } });
  const d = await svc.machineDetail(null, 25, 4);
  expect(d.live.total_energy).toBe(3104.12345);
  expect(d.power.total_kwh).toBe(3104.123);
  expect(d.power.shift_kwh).toBe(0);
});

test('a quiet change-only meter retains its last counter while status is offline', async () => {
  given({ online: false, measurement: { total_energy: '3104' } });
  const d = await svc.machineDetail(null, 25, 4);
  expect(d.live.machine_status).toBe('OFFLINE');
  expect(d.power.total_kwh).toBe(3104);
  expect(d.power.shift_kwh).toBeNull();
  const q = calls.find(c => ENERGY.test(c.text));
  const latest = q.text.slice(q.text.indexOf('(SELECT energy'));
  expect(latest).toContain("received_at >= $5::timestamptz - INTERVAL '30 days'");
  expect(latest).toContain("observed_at >= $5::timestamptz - INTERVAL '30 days'");
  expect(latest).not.toContain("INTERVAL '1 hour'");
  expect(latest).toMatch(/ORDER BY observed_at DESC, received_at DESC LIMIT 1/);
});

test('a single reading cannot create fake zero consumption', async () => {
  given({ measurement: { total_energy: '3104', shift_kwh: null, accepted_intervals: '0' } });
  const d = await svc.machineDetail(null, 25, 4);
  expect(d.power).toMatchObject({ total_kwh: 3104, shift_kwh: null, energy_complete: false });
});

test('reset and rejected intervals preserve measured consumption with incomplete coverage', async () => {
  given({ measurement: { total_energy: '5', shift_kwh: '22', accepted_intervals: '2', rejected_intervals: '1' } });
  const d = await svc.machineDetail(null, 25, 4);
  expect(d.power).toMatchObject({ total_kwh: 5, shift_kwh: 22, energy_complete: false, rejected_intervals: 1 });
  const q = calls.find(c => ENERGY.test(c.text));
  expect(q.text).toMatch(/LAG\(energy\) OVER w AS prev_energy/);
  expect(q.text).toMatch(/WHEN prev_energy IS NULL OR energy < prev_energy THEN NULL/);
  expect(q.text).toMatch(/energy - prev_energy > 2000 \* GREATEST\(EXTRACT\(EPOCH FROM observed_at - prev_at\), 300\) \/ 3600\.0 THEN NULL/);
  expect(q.text).toMatch(/SELECT SUM\(delta\) AS shift_kwh/);
});

test('counter reads enforce the checked machine company, current shift and no future data', async () => {
  given();
  await svc.machineDetail(null, 25, 4);
  const q = calls.find(c => ENERGY.test(c.text));
  expect(q.params).toEqual([25, new Date('2026-10-29T08:00:00+05:30'),
    new Date('2026-10-29T20:00:00+05:30'), 4, new Date('2026-10-29T12:00:00+05:30')]);
  expect(q.text.match(/company_id = \$4 AND machine_id = \$1/g)).toHaveLength(2);
  expect(q.text).toMatch(/received_at >= \$2::timestamptz/);
  expect(q.text).toMatch(/received_at < \$3::timestamptz/);
  expect(q.text.match(/received_at <= \$5::timestamptz/g)).toHaveLength(2);
  expect(q.text).toContain('observed_at >= $2::timestamptz');
  expect(q.text).toContain('observed_at < $3::timestamptz');
  expect(q.text.match(/observed_at <= \$5::timestamptz/g)).toHaveLength(2);
  expect(q.text).toContain('WINDOW w AS (ORDER BY observed_at, received_at)');
  expect(q.text).toContain('LAG(observed_at) OVER w AS prev_at');
  expect(q.text).not.toMatch(/FROM telemetry_raw/);
});

test('without a current shift the latest energy is still available and shift usage stays unknown', async () => {
  given({ shift: false, measurement: { total_energy: '3104', shift_kwh: null, accepted_intervals: 0 } });
  const d = await svc.machineDetail(null, 25, 4);
  expect(d.power).toMatchObject({ total_kwh: 3104, shift_kwh: null, energy_complete: false });
  expect(calls.find(c => ENERGY.test(c.text)).params.slice(1, 3)).toEqual([null, null]);
});

test('a foreign or missing machine cannot query its energy', async () => {
  answers.length = 0;
  calls.length = 0;
  expect(await svc.machineDetail(null, 25, 99)).toBeNull();
  expect(calls.some(c => ENERGY.test(c.text))).toBe(false);
});
