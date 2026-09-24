/*
 * The machine page and the alarm flag.
 *
 * The machine list shows an alarm as its own flag beside Running / Idle — a
 * CNC in alarm usually stops, so it reads IDLE while the alarm is on. The
 * machine detail response read `alarm` from telemetry and then dropped it,
 * so the page showed a plain "IDLE" for a machine the list was flashing red
 * (HMC-7-F, AIR PRESSURE LOW, 24 Sep 2026).
 *
 * machineDetail sends a long run of queries; the mock answers each by what
 * it asks for rather than by position, so this test does not break every
 * time an unrelated query is added to the function.
 */
const answers = [];
const calls = [];
jest.mock('../../src/db', () => ({
  query: jest.fn(async (text, params) => {
    calls.push({ text, params });
    const hit = answers.find(([re]) => re.test(text));
    return hit ? { rows: hit[1], rowCount: hit[1].length } : { rows: [], rowCount: 0 };
  })
}));

const svc = require('../../src/dashboard/dashboard.service');

const OPEN_ALARM = { alarm_code: 'EX1032', alarm_type: 'AIR PRESSURE LOW', message: 'AIR PRESSURE LOW',
                     severity: 'NORMAL', started_at: '2026-09-24T05:21:47.000Z' };

function given({ alarm, open = [] }) {
  answers.length = 0; calls.length = 0;
  answers.push(
    [/FROM machines\s+WHERE id = \$1 AND company_id = \$2/, [{ id: 25, machine_serial_no: 'HMC - 7 - F', image_url: null }]],
    [/FROM machine_alarms\s+WHERE machine_id = \$1 AND ended_at IS NULL/, open],
    [/FROM telemetry_raw\s+WHERE machine_id = \$1\s+ORDER BY received_at DESC/,
      [{ machine_status: 'IDLE', spindle_load: 0, feed_rate: 0, received_at: new Date(), alarm, mode: 'MEM', energy: null }]]
  );
}

test('a machine in alarm says so, and names the alarm, beside its IDLE status', async () => {
  given({ alarm: true, open: [OPEN_ALARM] });
  const d = await svc.machineDetail(1, 25, 4);
  expect(d.live.machine_status).toBe('IDLE');
  expect(d.live.alarm).toBe(true);
  expect(d.live.active_alarms).toEqual([OPEN_ALARM]);
});

test('no alarm reads false, not missing', async () => {
  given({ alarm: false });
  const d = await svc.machineDetail(1, 25, 4);
  expect(d.live.alarm).toBe(false);
  expect(d.live.active_alarms).toEqual([]);
});

test('the open alarms are this machine\'s, newest first, bounded', async () => {
  given({ alarm: true, open: [OPEN_ALARM] });
  await svc.machineDetail(1, 25, 4);
  const q = calls.find(c => /FROM machine_alarms\s+WHERE machine_id = \$1 AND ended_at IS NULL/.test(c.text));
  expect(q.params).toEqual([25]);
  expect(q.text).toMatch(/ORDER BY started_at DESC\s+LIMIT 5/);
});

test('a machine of another company is not found, and no alarm is read for it', async () => {
  answers.length = 0; calls.length = 0;
  expect(await svc.machineDetail(1, 25, 99)).toBeNull();
  expect(calls.some(c => /machine_alarms/.test(c.text))).toBe(false);
});
