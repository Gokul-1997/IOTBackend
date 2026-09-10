/*
 * Unit tests for dashboard/oee.dashboard.service — Phase 2 Screen 8.
 *
 * The decision this screen turns on is that OEE is recomputed from summed
 * totals rather than averaged from the per-hour values in oee_hourly.
 *
 * OEE is a product of three ratios, and averaging a ratio over periods
 * with different denominators does not give the ratio for the whole
 * period. Worse, an hour in which a machine produced nothing has
 * performance 0 and quality 0, so every idle hour drags the average toward
 * zero for reasons that have nothing to do with how the machine ran while
 * it was running. Against production, averaging reports 0.0% OEE;
 * recomputing reports 19.4%.
 *
 * The other half is honesty about what cannot be computed. Performance
 * needs a cycle time, and half the machines here have none. For those,
 * performance and OEE are unknown — not zero. Zero is a judgement; null is
 * the truth.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/oee.dashboard.service');

const T = svc.DEFAULT_THRESHOLDS;

/** One machine's totals as the aggregate query returns them. */
const row = (over = {}) => ({
  machine_id: 1, machine_serial_no: 'VMC-01', model: 'VF700',
  run_seconds: '1800', idle_seconds: '1800', produced: '30', hours: 1,
  cycle_seconds: '60', mult: '1', rejected: '0', alarm_count: 0,
  downtime_seconds: '0', machine_status: 'RUNNING', alarm: false, ...over
});

beforeEach(() => resetDb());

describe('the three components', () => {
  test('availability is run over planned', () => {
    // one hour planned, half of it running
    const d = svc.deriveOee(row({ run_seconds: '1800', hours: 1 }), T);
    expect(d.availability_pct).toBe(50);
  });

  test('performance is produced over what the cycle time allows', () => {
    // 1800s of running at a 60s cycle allows 30 parts; 30 were made
    const d = svc.deriveOee(row({ run_seconds: '1800', cycle_seconds: '60', produced: '30' }), T);
    expect(d.performance_pct).toBe(100);
  });

  test('performance accounts for parts per cycle', () => {
    const d = svc.deriveOee(row({ run_seconds: '1800', cycle_seconds: '60', mult: '2', produced: '30' }), T);
    expect(d.performance_pct).toBe(50);   // 60 possible, 30 made
  });

  test('performance is capped at 100', () => {
    // over 100 means the configured cycle time is shorter than reality —
    // a data problem to fix, not a performance to report
    const d = svc.deriveOee(row({ run_seconds: '1800', cycle_seconds: '60', produced: '90' }), T);
    expect(d.performance_pct).toBe(100);
  });

  test('quality is good over produced', () => {
    const d = svc.deriveOee(row({ produced: '100', rejected: '10' }), T);
    expect(d.quality_pct).toBe(90);
    expect(d.good).toBe(90);
    expect(d.rejection_rate_pct).toBe(10);
  });

  test('OEE is the product of the three', () => {
    const d = svc.deriveOee(row({ run_seconds: '1800', hours: 1, cycle_seconds: '60',
                                  produced: '30', rejected: '3' }), T);
    // A 50% x P 100% x Q 90%
    expect(d.availability_pct).toBe(50);
    expect(d.quality_pct).toBe(90);
    expect(d.oee_pct).toBe(45);
  });
});

describe('unknown is not zero', () => {
  test('no cycle time means performance and OEE are null', () => {
    const d = svc.deriveOee(row({ cycle_seconds: null }), T);
    expect(d.performance_pct).toBeNull();
    expect(d.oee_pct).toBeNull();
    expect(d.has_cycle_time).toBe(false);
    // availability and production are still knowable and still reported
    expect(d.availability_pct).not.toBeNull();
    expect(d.produced).toBe(30);
  });

  test('a machine like that is banded UNKNOWN, not POOR', () => {
    // POOR is a judgement about the machine; UNKNOWN is a statement about
    // our configuration
    expect(svc.deriveOee(row({ cycle_seconds: null }), T).band).toBe('UNKNOWN');
  });

  test('nothing produced means quality is unknown, not zero', () => {
    const d = svc.deriveOee(row({ produced: '0', rejected: '0' }), T);
    expect(d.quality_pct).toBeNull();
    expect(d.oee_pct).toBeNull();
  });

  test('no recorded hours means availability is unknown', () => {
    const d = svc.deriveOee(row({ hours: 0, run_seconds: '0' }), T);
    expect(d.availability_pct).toBeNull();
    expect(d.oee_pct).toBeNull();
  });

  test('good never goes negative when rejects exceed the telemetry count', () => {
    // rejects are entered by hand, produced comes from telemetry
    expect(svc.deriveOee(row({ produced: '5', rejected: '50' }), T).good).toBe(0);
  });
});

describe('fleet figures are recomputed, never averaged', () => {
  const machines = [
    svc.deriveOee(row({ machine_id: 1, run_seconds: '3600', hours: 1, cycle_seconds: '60', produced: '60' }), T),
    // a machine that ran a minute: its percentages must not carry the same
    // weight as one that ran an hour
    svc.deriveOee(row({ machine_id: 2, run_seconds: '60', hours: 1, cycle_seconds: '60', produced: '1' }), T)
  ];

  test('availability is total run over total planned', () => {
    const f = svc.fleetOee(machines, T);
    // 3660 run of 7200 planned
    expect(f.availability_pct).toBe(50.8);
  });

  test('performance is weighted by how long each machine ran', () => {
    const f = svc.fleetOee(machines, T);
    // both are at 100%, so the weighted figure is 100 — the point is that
    // it comes from run time, not from a plain mean of percentages
    expect(f.performance_pct).toBe(100);
  });

  test('machines without a cycle time are excluded from performance but counted in production', () => {
    const withUnknown = [...machines, svc.deriveOee(row({ machine_id: 3, cycle_seconds: null, produced: '500' }), T)];
    const f = svc.fleetOee(withUnknown, T);

    expect(f.machines_total).toBe(3);
    expect(f.machines_measurable).toBe(2);
    expect(f.produced).toBe(561);           // the unknown machine's output still counts
  });

  test('fleet OEE is null when any component is unknown', () => {
    const f = svc.fleetOee([svc.deriveOee(row({ cycle_seconds: null }), T)], T);
    expect(f.performance_pct).toBeNull();
    expect(f.oee_pct).toBeNull();
  });
});

describe('classification', () => {
  test.each([
    [90, 'GOOD'], [85, 'GOOD'], [84.9, 'FAIR'], [60, 'FAIR'], [59.9, 'POOR'], [0, 'POOR']
  ])('%i%% is %s at the default thresholds', (oee, band) => {
    expect(svc.classify(oee, T)).toBe(band);
  });

  test('null OEE is UNKNOWN', () => {
    expect(svc.classify(null, T)).toBe('UNKNOWN');
  });

  test('thresholds can be set per request', () => {
    const t = svc.resolveThresholds({ threshold_good: 70, threshold_fair: 40 });
    expect(t).toEqual({ good: 70, fair: 40 });
    expect(svc.classify(75, t)).toBe('GOOD');
  });

  test('defaults to the world-class 85 / 60 bands', () => {
    expect(svc.resolveThresholds({})).toEqual({ good: 85, fair: 60 });
  });

  test.each([[-1], [101], ['abc']])('rejects an out-of-range threshold %p', (bad) => {
    expect(() => svc.resolveThresholds({ threshold_good: bad })).toThrow(
      expect.objectContaining({ status: 400 }));
  });

  test('rejects a fair threshold above the good one', () => {
    expect(() => svc.resolveThresholds({ threshold_good: 50, threshold_fair: 80 }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('live status', () => {
  test.each([
    ['no telemetry in the last hour', { machine_status: null }, 'OFFLINE'],
    ['alarming',                      { machine_status: 'IDLE', alarm: true }, 'ALARM'],
    ['running',                       { machine_status: 'RUNNING', alarm: false }, 'RUNNING'],
    ['idle',                          { machine_status: 'IDLE', alarm: false }, 'IDLE']
  ])('%s is %s', (_label, over, expected) => {
    expect(svc.statusOf({ ...row(), ...over })).toBe(expected);
  });

  test('an alarming machine reads ALARM even if telemetry says running', () => {
    // the alarm is the more important fact for someone scanning the floor
    expect(svc.statusOf({ machine_status: 'RUNNING', alarm: true })).toBe('ALARM');
  });
});

describe('the aggregate query', () => {
  function queueAll(rows = []) {
    mockDb.queueResponse({ rows }, { rows: [] });
  }

  test('bounds the live-status lookup so it cannot scan every chunk', async () => {
    queueAll();
    await svc.getOee({ company_id: 4 });
    // telemetry_raw is a hypertable with ~183 chunks; without a
    // received_at predicate the planner cannot prune any of them
    expect(mockDb.calls()[0].text).toMatch(/t\.received_at > NOW\(\) - INTERVAL '1 hour'/);
  });

  test('scopes quality through the machine, since the table has no company_id', async () => {
    queueAll();
    await svc.getOee({ company_id: 4 });
    expect(mockDb.calls()[0].text).toMatch(/JOIN machines qm ON qm\.id = q\.machine_id AND qm\.company_id = \$1/);
  });

  test('does not read oee_hourly at all', async () => {
    queueAll();
    await svc.getOee({ company_id: 4 });
    for (const c of mockDb.calls()) expect(c.text).not.toMatch(/oee_hourly/);
  });

  test.each([
    ['no filters', {}], ['dates', { from: '2026-09-01', to: '2026-09-10' }],
    ['machine', { machine_id: 3 }], ['shift', { shift_id: 5 }],
    ['both', { machine_id: 3, shift_id: 5, from: '2026-09-01', to: '2026-09-10' }]
  ])('binds exactly the parameters it references — %s', async (_label, filters) => {
    queueAll();
    await svc.getOee({ company_id: 4, ...filters });
    for (const call of mockDb.calls()) {
      const used = [...call.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
      const hi = used.length ? Math.max(...used) : 0;
      expect(call.params.length).toBe(hi);
      for (let i = 1; i <= hi; i++) expect(used).toContain(i);
    }
  });
});

describe('top and bottom lists', () => {
  function queueMachines(n) {
    const rows = Array.from({ length: n }, (_, i) => row({
      machine_id: i + 1, machine_serial_no: `M${i + 1}`,
      run_seconds: String(600 * (i + 1)), hours: 1
    }));
    mockDb.queueResponse({ rows }, { rows: [] });
  }

  test('never place the same machine in both, even with few machines', async () => {
    queueMachines(6);
    const d = await svc.getOee({ company_id: 4 });

    const top = d.top_machines.map(m => m.machine_serial_no);
    const bottom = d.bottom_machines.map(m => m.machine_serial_no);
    // appearing as both best and worst on one screen destroys trust in
    // everything else on it
    expect(top.filter(x => bottom.includes(x))).toEqual([]);
  });

  test('rank only machines whose OEE could be computed', async () => {
    mockDb.queueResponse({ rows: [
      row({ machine_id: 1, machine_serial_no: 'HAS' }),
      row({ machine_id: 2, machine_serial_no: 'NONE', cycle_seconds: null })
    ] }, { rows: [] });

    const d = await svc.getOee({ company_id: 4 });
    // ranking a machine last for a missing cycle time would blame it for a
    // configuration gap
    expect(d.top_machines.map(m => m.machine_serial_no)).toEqual(['HAS']);
    expect(d.coverage.oee_computable).toBe(1);
  });
});

describe('coverage is disclosed', () => {
  test('says how many machines have a cycle time', async () => {
    mockDb.queueResponse({ rows: [
      row({ machine_id: 1 }), row({ machine_id: 2, cycle_seconds: null })
    ] }, { rows: [] });

    const d = await svc.getOee({ company_id: 4 });
    expect(d.coverage.machines).toBe(2);
    expect(d.coverage.with_cycle_time).toBe(1);
    expect(d.coverage.note).toMatch(/cycle time/i);
  });

  test('counts the four live states', async () => {
    mockDb.queueResponse({ rows: [
      row({ machine_id: 1, machine_status: 'RUNNING' }),
      row({ machine_id: 2, machine_status: 'IDLE' }),
      row({ machine_id: 3, machine_status: 'IDLE', alarm: true }),
      row({ machine_id: 4, machine_status: null })
    ] }, { rows: [] });

    const d = await svc.getOee({ company_id: 4 });
    expect(d.status_counts).toEqual({ RUNNING: 1, IDLE: 1, ALARM: 1, OFFLINE: 1 });
  });
});

describe('input validation', () => {
  test.each([['machine_id'], ['shift_id']])('%s must be a positive integer', async (field) => {
    await expect(svc.getOee({ company_id: 4, [field]: 'abc' })).rejects.toMatchObject({ status: 400 });
  });

  test.each([['nope'], ['2026-13-01']])('rejects date %p', async (bad) => {
    await expect(svc.getOee({ company_id: 4, from: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a backwards range', async () => {
    await expect(svc.getOee({ company_id: 4, from: '2026-09-10', to: '2026-09-01' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('export', () => {
  test('carries the columns the report is specified to have', async () => {
    mockDb.queueResponse({ rows: [row()] }, { rows: [] });
    const rows = await svc.getExportRows({ company_id: 4 });

    expect(Object.keys(rows[0])).toEqual([
      'Machine', 'Status', 'Availability', 'Performance', 'Quality', 'OEE', 'Band',
      'Production', 'Good parts', 'Rejections', 'Rejection rate', 'Downtime', 'Alarms'
    ]);
  });

  test('an unknown figure exports blank rather than a misleading zero', async () => {
    mockDb.queueResponse({ rows: [row({ cycle_seconds: null })] }, { rows: [] });
    const rows = await svc.getExportRows({ company_id: 4 });
    expect(rows[0]['Performance']).toBe('');
    expect(rows[0]['OEE']).toBe('');
    expect(rows[0]['Band']).toBe('UNKNOWN');
  });
});
