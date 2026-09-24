/*
 * The machine page's shift timeline: the current shift as Running / Idle /
 * Alarm / Off periods with its breaks marked. The periods must cover the
 * shift so far exactly — no gaps, no overlaps — or the bar and its totals
 * would disagree with each other.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const tl = require('../../src/dashboard/timeline.service');
const { buildSegments, shiftWindow } = tl._internal;

const T = (hhmm, date = '2026-09-24') => Date.parse(`${date}T${hhmm}:00+05:30`);
const S = 1000, MIN = 60 * S;
const show = segs => segs.map(s => `${s.state} ${new Date(s.from + 330 * MIN).toISOString().slice(11, 16)}-${new Date(s.to + 330 * MIN).toISOString().slice(11, 16)}`);

beforeEach(() => resetDb());

describe('building the periods', () => {
  const start = T('08:00');

  test('state changes become periods that cover the shift exactly', () => {
    const rows = [
      { t: start + 5 * S, st: 'IDLE', prev_t: null },
      { t: T('09:00'), st: 'RUNNING', prev_t: T('09:00') - 5 * S },
      { t: T('10:00'), st: 'ALARM', prev_t: T('10:00') - 5 * S }
    ];
    const segs = buildSegments(rows, T('11:00') - 5 * S, start, T('11:00'));
    expect(show(segs)).toEqual(['IDLE 08:00-09:00', 'RUNNING 09:00-10:00', 'ALARM 10:00-11:00']);
    expect(segs.reduce((n, s) => n + s.to - s.from, 0)).toBe(T('11:00') - start);
  });

  test('samples stopping for over a minute is Off, whatever the state was', () => {
    const rows = [
      { t: start, st: 'RUNNING', prev_t: null },
      { t: T('09:30'), st: 'RUNNING', prev_t: T('09:00') }     // nothing from 09:00 to 09:30
    ];
    const segs = buildSegments(rows, T('10:00'), start, T('10:00'));
    expect(show(segs)).toEqual(['RUNNING 08:00-09:00', 'OFF 09:00-09:30', 'RUNNING 09:30-10:00']);
  });

  test('a gap of under a minute is not Off', () => {
    const rows = [
      { t: start, st: 'RUNNING', prev_t: null },
      { t: T('09:00'), st: 'IDLE', prev_t: T('09:00') - 50 * S }
    ];
    expect(show(buildSegments(rows, T('10:00'), start, T('10:00')))).toEqual(['RUNNING 08:00-09:00', 'IDLE 09:00-10:00']);
  });

  test('nothing received yet this shift is Off from the start', () => {
    const rows = [{ t: T('08:23'), st: 'IDLE', prev_t: null }];
    expect(show(buildSegments(rows, T('09:00'), start, T('09:00')))).toEqual(['OFF 08:00-08:23', 'IDLE 08:23-09:00']);
  });

  test('a machine that went quiet is Off since its last sample', () => {
    const rows = [{ t: start, st: 'RUNNING', prev_t: null }];
    expect(show(buildSegments(rows, T('09:00'), start, T('10:00')))).toEqual(['RUNNING 08:00-09:00', 'OFF 09:00-10:00']);
  });

  test('no samples at all is one Off period', () => {
    expect(show(buildSegments([], start, start, T('09:00')))).toEqual(['OFF 08:00-09:00']);
  });

  test('a gap row with no change of state still splits around the Off', () => {
    const rows = [
      { t: start, st: 'IDLE', prev_t: null },
      { t: T('08:10'), st: 'IDLE', prev_t: T('08:05') }
    ];
    expect(show(buildSegments(rows, T('08:20'), start, T('08:20')))).toEqual(['IDLE 08:00-08:05', 'OFF 08:05-08:10', 'IDLE 08:10-08:20']);
  });
});

describe('which instance of the shift', () => {
  const day = { start_time: '08:00:00', end_time: '20:00:00' };
  const night = { start_time: '20:00:00', end_time: '08:00:00' };

  test('a day shift starts today, in plant time', () => {
    expect(shiftWindow(day, T('14:30'))).toEqual({ start: T('08:00'), end: T('20:00') });
  });

  test('a night shift after midnight began yesterday evening', () => {
    expect(shiftWindow(night, T('02:00'))).toEqual({ start: T('20:00', '2026-09-23'), end: T('08:00') });
  });

  test('a night shift before midnight began this evening', () => {
    expect(shiftWindow(night, T('22:00'))).toEqual({ start: T('20:00'), end: T('08:00', '2026-09-25') });
  });

  test('plant time, not the server zone: 01:30 IST is still the 24th', () => {
    // 20:00 UTC on the 23rd is 01:30 IST on the 24th
    expect(shiftWindow(night, Date.parse('2026-09-23T20:00:00Z')).start).toBe(T('20:00', '2026-09-23'));
  });
});

describe('machineTimeline', () => {
  const NOW = T('11:00');
  const shiftRow = { id: 5, shift_code: 'Shift 1', shift_name: 'Morning', start_time: '08:00:00', end_time: '20:00:00', break_minutes: 60 };

  function given({ machine = [{ id: 25 }], shift = [shiftRow], changes = [], last = null, breaks = [] } = {}) {
    mockDb.queueResponse({ rows: machine }, { rows: shift },
      { rows: changes }, { rows: [{ last }] }, breaks instanceof Error ? breaks : { rows: breaks });
  }

  test('another company\'s machine is not found, and nothing else is read', async () => {
    mockDb.queueResponse({ rows: [] });
    expect(await tl.machineTimeline(25, 99, NOW)).toBeNull();
    expect(mockDb.calls()).toHaveLength(1);
    expect(mockDb.calls()[0].params).toEqual([25, 99]);
  });

  test('a bad id is a 400 before any query', async () => {
    await expect(tl.machineTimeline('abc', 4, NOW)).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('no shift running now says so', async () => {
    given({ shift: [] });
    const d = await tl.machineTimeline(25, 4, NOW);
    expect(d.shift).toBeNull();
    expect(d.segments).toEqual([]);
  });

  test('reads only this machine\'s samples within the shift so far', async () => {
    given({ changes: [{ t: String(T('08:00')), st: 'RUNNING', prev_t: null }], last: String(NOW - 5 * S) });
    await tl.machineTimeline(25, 4, NOW);
    const q = mockDb.calls().find(c => /LAG\(st\)/.test(c.text));
    expect(q.params).toEqual([25, new Date(T('08:00')), new Date(NOW)]);
    expect(q.text).toMatch(/WHEN alarm THEN 'ALARM'/);
    expect(q.text).toMatch(/t - prev_t > INTERVAL '60 seconds'/);
  });

  test('breaks are placed on the shift, and their elapsed part totalled', async () => {
    given({
      changes: [{ t: String(T('08:00')), st: 'RUNNING', prev_t: null }], last: String(NOW - 5 * S),
      breaks: [{ break_name: 'Lunch', start_time: '13:00', end_time: '13:30' },
               { break_name: 'Tea Break', start_time: '10:45', end_time: '11:15' }]
    });
    const d = await tl.machineTimeline(25, 4, NOW);
    expect(d.breaks).toEqual([
      { name: 'Tea Break', from: T('10:45'), to: T('11:15') },
      { name: 'Lunch', from: T('13:00'), to: T('13:30') }
    ]);
    expect(d.totals.breaks).toBe(15 * MIN);           // 10:45 to now (11:00)
    expect(d.totals.RUNNING).toBe(3 * 60 * MIN);
    expect(d.breaks_configured).toBe(true);
  });

  test('a night-shift break after midnight lands on the next day', async () => {
    const night = { ...shiftRow, start_time: '20:00:00', end_time: '08:00:00' };
    given({ shift: [night], breaks: [{ break_name: 'Tea', start_time: '02:00', end_time: '02:15' }] });
    const d = await tl.machineTimeline(25, 4, T('01:00'));
    expect(d.breaks).toEqual([{ name: 'Tea', from: T('02:00'), to: T('02:15') }]);
  });

  test('before migration 028 the timeline still works, without breaks', async () => {
    given({ breaks: Object.assign(new Error('relation "shift_breaks" does not exist'), { code: '42P01' }) });
    const d = await tl.machineTimeline(25, 4, NOW);
    expect(d.breaks_configured).toBe(false);
    expect(d.breaks).toEqual([]);
    expect(d.segments).toEqual([{ state: 'OFF', from: T('08:00'), to: NOW }]);
  });
});
