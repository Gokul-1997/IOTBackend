/*
 * The three-month rule, and the column whitelist behind an emailed report.
 *
 * Both exist to stop a report request becoming an outage: an unbounded date
 * range streams six figures of hourly rows into one JSON response, and a
 * column list taken straight from the request would let an unknown key
 * become a spreadsheet header or a column of blanks.
 */

const {
  MAX_DIRECT_DAYS, rangeDays, exceedsDirectLimit, assertDirectRange
} = require('../../src/reports/report.limits');

const {
  resolveColumns, shapeRows, assertType, REPORT_COLUMNS
} = require('../../src/reports/report.columns');

describe('range length', () => {
  test('a single day is one day, not zero', () => {
    expect(rangeDays('2026-09-16', '2026-09-16')).toBe(1);
  });

  test('counts both ends', () => {
    expect(rangeDays('2026-09-01', '2026-09-30')).toBe(30);
  });

  test('crosses a month and a leap day correctly', () => {
    expect(rangeDays('2024-02-27', '2024-03-01')).toBe(4);   // 27, 28, 29, 1
  });

  test('a range ending before it starts is rejected, not negative', () => {
    expect(() => rangeDays('2026-09-16', '2026-09-01')).toThrow(/before/i);
  });

  test.each(['', null, undefined, '16-09-2026', '2026-9-1', 'yesterday', '2026-13-01'])(
    'refuses %p as a date', bad => {
      expect(() => rangeDays(bad, '2026-09-16')).toThrow();
    });
});

describe('the direct-download limit', () => {
  test('exactly the limit is still allowed — the boundary is inclusive', () => {
    const to = new Date(Date.UTC(2026, 0, 1) + (MAX_DIRECT_DAYS - 1) * 86400000)
      .toISOString().slice(0, 10);
    expect(rangeDays('2026-01-01', to)).toBe(MAX_DIRECT_DAYS);
    expect(() => assertDirectRange('2026-01-01', to)).not.toThrow();
    expect(exceedsDirectLimit('2026-01-01', to)).toBe(false);
  });

  test('one day past the limit is refused', () => {
    const to = new Date(Date.UTC(2026, 0, 1) + MAX_DIRECT_DAYS * 86400000)
      .toISOString().slice(0, 10);
    expect(exceedsDirectLimit('2026-01-01', to)).toBe(true);
    expect(() => assertDirectRange('2026-01-01', to)).toThrow();
  });

  test('the refusal carries the numbers the message needs', () => {
    try {
      assertDirectRange('2025-01-01', '2026-01-01');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.status).toBe(413);
      expect(e.code).toBe('RANGE_TOO_LARGE');
      expect(e.days).toBe(366);
      expect(e.max_days).toBe(MAX_DIRECT_DAYS);
      // the user is told what to do, not merely refused
      expect(e.message).toMatch(/emailed/i);
    }
  });

  test('a year of hourly rows is what the limit exists to prevent', () => {
    // 20 machines × 24 hours × 365 days — the shape of the unbounded query
    expect(20 * 24 * 365).toBeGreaterThan(100000);
    expect(exceedsDirectLimit('2025-09-16', '2026-09-16')).toBe(true);
  });
});

describe('report types', () => {
  test('accepts the three real types', () => {
    ['production', 'oee-hourly', 'shift-oee'].forEach(t => expect(assertType(t)).toBe(t));
  });

  test('rejects anything else, naming what is valid', () => {
    expect(() => assertType('everything')).toThrow(/production/);
    expect(() => assertType(undefined)).toThrow();
  });
});

describe('column selection', () => {
  test('no selection means the defaults, never no columns', () => {
    const cols = resolveColumns('production', []);
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.every(c => c.default)).toBe(true);
  });

  test('an absent selection behaves the same as an empty one', () => {
    expect(resolveColumns('production', undefined)).toEqual(resolveColumns('production', []));
  });

  test('order comes from the report, not the request', () => {
    const asked = resolveColumns('production', ['energy_kwh', 'machine', 'shift']);
    expect(asked.map(c => c.key)).toEqual(['machine', 'shift', 'energy_kwh']);
  });

  test('a non-default column can be asked for explicitly', () => {
    expect(resolveColumns('production', ['setup_time']).map(c => c.key)).toEqual(['setup_time']);
  });

  test('an unknown key is refused rather than becoming an empty column', () => {
    expect(() => resolveColumns('production', ['machine', 'password'])).toThrow(/password/);
  });

  test('a column of another report type is not silently accepted', () => {
    // 'availability' belongs to the OEE reports, not production
    expect(() => resolveColumns('production', ['availability'])).toThrow(/availability/);
  });

  test('every declared default exists in its own definition', () => {
    for (const [type, cols] of Object.entries(REPORT_COLUMNS)) {
      expect(cols.length).toBeGreaterThan(0);
      expect(new Set(cols.map(c => c.key)).size).toBe(cols.length);   // no duplicates
      expect(cols.some(c => c.default)).toBe(true);                   // at least one default
      expect(type).toBeTruthy();
    }
  });
});

describe('shaping rows for the spreadsheet', () => {
  const cols = resolveColumns('production', ['machine', 'produced_qty']);

  test('headers are the labels a person reads, not the database keys', () => {
    const [row] = shapeRows([{ machine: 'CNC-01', produced_qty: 42, energy_kwh: 9 }], cols);
    expect(Object.keys(row)).toEqual(['Machine', 'Parts Made']);
    expect(row['Parts Made']).toBe(42);
  });

  test('only the chosen columns travel — nothing else leaks into the file', () => {
    const [row] = shapeRows([{ machine: 'CNC-01', produced_qty: 1, operator: 'Suresh' }], cols);
    expect(row).not.toHaveProperty('Operator');
  });

  test('a missing value is blank, never the string "undefined"', () => {
    const [row] = shapeRows([{ machine: 'CNC-01' }], cols);
    expect(row['Parts Made']).toBe('');
  });

  test('zero survives as zero rather than being blanked', () => {
    const [row] = shapeRows([{ machine: 'CNC-01', produced_qty: 0 }], cols);
    expect(row['Parts Made']).toBe(0);
  });

  test('no rows produces no rows, not a row of blanks', () => {
    expect(shapeRows([], cols)).toEqual([]);
  });
});
