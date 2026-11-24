const answers = [];
const calls = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text, params) => {
    calls.push({ text, params });
    const hit = answers.find(([re]) => re.test(text));
    return { rows: hit ? hit[1] : [] };
  })
}));
const service = require('../../src/dashboard/dashboard.service');

const NOW = Date.parse('2026-11-24T12:00:00+05:30');
const TELEMETRY = /FROM telemetry_raw\s+WHERE machine_id = \$1\s+AND company_id = \$2/;
function given(value, { ageMs = 1000, observedAgeMs = ageMs, observedAt = Math.floor((NOW - observedAgeMs) / 1000), omitted = false } = {}) {
  answers.length = 0;
  calls.length = 0;
  answers.push(
    [/FROM machines\s+WHERE id = \$1 AND company_id = \$2/,
      [{ id: 19, machine_serial_no: 'VMC19', image_url: null }]],
    [TELEMETRY, [{ machine_status: 'IDLE', alarm: true, received_at: new Date(NOW - ageMs),
      controller_downtime_observed_at: observedAt,
      ...(omitted ? {} : { controller_downtime_value: value }) }]],
    [/FROM machine_alarms/, [{ alarm_code: 'EX1071', alarm_type: 'AIR PRESSURE NOT OK',
      message: 'AIR PRESSURE NOT OK', severity: 'NORMAL', started_at: new Date(NOW - 5000) }]]
  );
}
beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
afterEach(() => jest.useRealTimers());

test.each([4, 0, '4', '0', 4.25])('the current raw controller value %j survives without a reason or duration interpretation', async value => {
  given(value);
  const data = await service.machineDetail(null, 19, 4);
  expect(data.live.controller_downtime_value).toBe(Number(value));
  expect(data.live.controller_downtime_observed_at).toBe(Math.floor((NOW - 1000) / 1000));
  expect(data.live.active_alarms[0]).toMatchObject({ alarm_code: 'EX1071', message: 'AIR PRESSURE NOT OK' });
  expect(data.live).not.toHaveProperty('downtime_reason_id');
  expect(data.live).not.toHaveProperty('downtime_seconds');
  expect(calls.every(call => !/INSERT|UPDATE|DELETE/.test(call.text))).toBe(true);
});

test.each([null, undefined, '', 'unknown', Number.NaN, Number.POSITIVE_INFINITY, false, {}])(
  'missing or invalid raw controller value %j remains unknown', async value => {
    given(value);
    expect((await service.machineDetail(null, 19, 4)).live.controller_downtime_value).toBeNull();
  }
);

test('a sparse current snapshot does not reuse a previous controller value', async () => {
  given(4);
  expect((await service.machineDetail(null, 19, 4)).live.controller_downtime_value).toBe(4);
  given(undefined, { omitted: true });
  expect((await service.machineDetail(null, 19, 4)).live.controller_downtime_value).toBeNull();
});

test.each([61000, -1000])('an offline or future snapshot cannot advertise a current controller value: age %s ms', async ageMs => {
  given(4, { ageMs });
  const data = await service.machineDetail(null, 19, 4);
  expect(data.live.machine_status).toBe('OFFLINE');
  expect(data.live.controller_downtime_value).toBeNull();
  expect(data.live.controller_downtime_observed_at).toBeNull();
});

test.each([61000, -1000])('fresh receipt never replaces a stale or future device observation: age %s ms', async observedAgeMs => {
  given(4, { ageMs: 0, observedAgeMs });
  const data = await service.machineDetail(null, 19, 4);
  expect(data.live.machine_status).toBe('IDLE');
  expect(data.live.controller_downtime_value).toBeNull();
  expect(data.live.controller_downtime_observed_at).toBeNull();
});

test.each([null, undefined, 'unknown', 4.5])('an absent or invalid device timestamp %j cannot fall back to receipt', async observedAt => {
  given(4, { observedAt });
  if (observedAt === undefined) delete answers.find(([re]) => re === TELEMETRY)[1][0].controller_downtime_observed_at;
  const data = await service.machineDetail(null, 19, 4);
  expect(data.live.controller_downtime_value).toBeNull();
  expect(data.live.controller_downtime_observed_at).toBeNull();
});

test('the bounded tenant-scoped projection tolerates databases awaiting migration 067', async () => {
  given(null);
  await service.machineDetail(null, 19, 4);
  const query = calls.find(call => TELEMETRY.test(call.text));
  expect(query.params).toEqual([19, 4]);
  expect(query.text).toContain("to_jsonb(telemetry_raw)->>'controller_downtime_value'");
  expect(query.text).toContain("to_jsonb(telemetry_raw)->>'device_time'");
  expect(query.text).not.toContain('telemetry_raw.controller_downtime_value');
  expect(query.text).toContain("received_at > NOW() - INTERVAL '1 hour'");
  expect(query.text).toContain('received_at <= NOW()');
  expect(query.text).toMatch(/ORDER BY received_at DESC\s+LIMIT 1/);
});

test('a foreign machine cannot expose a controller value or query its telemetry', async () => {
  answers.length = 0;
  calls.length = 0;
  expect(await service.machineDetail(null, 19, 99)).toBeNull();
  expect(calls.some(call => TELEMETRY.test(call.text))).toBe(false);
});

test('a configured machine code resolves by company/code rather than by database reason ID', async () => {
  given(4);
  answers.push([/FROM downtime_reasons/, [{ id: 25, code: '4', name: 'TEA', category: 'PLANNED' }]]);
  const data = await service.machineDetail(null, 19, 4);
  expect(data.live.controller_downtime_reason).toEqual({ id: 25, code: '4', name: 'TEA', category: 'PLANNED' });
  const query = calls.find(call => /FROM downtime_reasons/.test(call.text));
  expect(query.params).toEqual([4, '4']);
  expect(query.text).toContain('BTRIM(code)=$2');
});

test('zero remains a clear signal even if the configured catalogue contains code zero', async () => {
  given(0);
  const data = await service.machineDetail(null, 19, 4);
  expect(data.live.controller_downtime_reason).toBeNull();
  expect(calls.some(call => /FROM downtime_reasons/.test(call.text))).toBe(false);
});
