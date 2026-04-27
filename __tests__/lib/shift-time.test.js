const {
  timeToMinutes,
  shiftDurationMinutes,
  plannedMinutes,
  isOvernight
} = require('../../src/lib/shift-time');

describe('timeToMinutes', () => {
  test.each([
    ['00:00', 0],
    ['08:00', 480],
    ['08:30', 510],
    ['20:00', 1200],
    ['23:59', 1439]
  ])('%s → %d', (input, expected) => {
    expect(timeToMinutes(input)).toBe(expected);
  });

  test('null/empty → 0', () => {
    expect(timeToMinutes(null)).toBe(0);
    expect(timeToMinutes('')).toBe(0);
  });
});

describe('shiftDurationMinutes', () => {
  test('day shift 08:00 → 20:00 = 720 min', () => {
    expect(shiftDurationMinutes('08:00', '20:00')).toBe(720);
  });

  test('overnight shift 20:00 → 08:00 = 720 min', () => {
    expect(shiftDurationMinutes('20:00', '08:00')).toBe(720);
  });

  test('short shift 09:00 → 13:00 = 240 min', () => {
    expect(shiftDurationMinutes('09:00', '13:00')).toBe(240);
  });

  test('overnight 22:00 → 06:00 = 480 min', () => {
    expect(shiftDurationMinutes('22:00', '06:00')).toBe(480);
  });
});

describe('plannedMinutes', () => {
  test('subtracts breaks', () => {
    expect(plannedMinutes('08:00', '20:00', 60)).toBe(660);
  });

  test('ignores breaks when 0/null', () => {
    expect(plannedMinutes('08:00', '20:00', 0)).toBe(720);
    expect(plannedMinutes('08:00', '20:00')).toBe(720);
  });

  test('floors at 1 even when breaks > duration', () => {
    expect(plannedMinutes('08:00', '09:00', 9999)).toBe(1);
  });
});

describe('isOvernight', () => {
  test('20:00 → 08:00 is overnight', () => {
    expect(isOvernight('20:00', '08:00')).toBe(true);
  });

  test('08:00 → 20:00 is not overnight', () => {
    expect(isOvernight('08:00', '20:00')).toBe(false);
  });
});
