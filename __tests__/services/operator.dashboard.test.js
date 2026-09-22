/*
 * Unit tests for dashboard/operator.service — Phase 2 Screen 7.
 *
 * Two things this screen has to get right:
 *
 *   Attribution. No production table carries an operator; the only link is
 *   operator_machine_assignments, which is not exclusive. So each operator
 *   carries the full figures for the machines they hold, every row says how
 *   many are shared, and fleet totals count each machine once.
 *
 *   The same numbers as the OEE Dashboard. Per-machine totals and the OEE
 *   arithmetic are that screen's own. This screen used to average
 *   oee_hourly — 0 or empty for almost every hour — so every operator read
 *   0% OEE while the OEE Dashboard showed real figures for their machines.
 *
 * getOperators fires three queries at once: assignments, machine totals,
 * the operator list. They are answered in that order.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/operator.service');
const oeeSvc = require('../../src/dashboard/oee.dashboard.service');

const company_id = 4;

const link = (over = {}) => ({
  operator_id: 1, operator_code: 'OP1', operator_name: 'A. Kumar', skill_level: 'L2',
  machine_id: 10, shift_name: 'Morning Shift', ...over
});

/** One machine as machineTotals returns it: 10 hours on, 6 of them cutting. */
const machine = (over = {}) => ({
  machine_id: 10, machine_serial_no: 'VMC-10', model: 'V', run_seconds: '21600', idle_seconds: '14400',
  produced: '100', hours: 10, cycle_seconds: '180', mult: '1', rejected: '5',
  alarm_count: 3, downtime_seconds: '0', machine_status: 'RUNNING', alarm: false, ...over
});

function queue(links = [link()], machines = [machine()], options = [{ id: 1, operator_code: 'OP1', operator_name: 'A. Kumar' }]) {
  mockDb.queueResponse({ rows: links }, { rows: machines }, { rows: options });
}

beforeEach(() => resetDb());

describe('where the figures come from', () => {
  test('the OEE Dashboard\'s machine totals — never oee_hourly', async () => {
    queue();
    await svc.getOperators({ company_id });
    const texts = mockDb.calls().map(c => c.text);
    expect(texts.some(t => /oee_hourly/.test(t))).toBe(false);
    expect(texts[1]).toMatch(/FROM production_hourly/);
    expect(texts[1]).toMatch(/machine_current_job/);           // the cycle time
  });

  test('an operator\'s OEE is exactly what the OEE Dashboard reports for the same machines', async () => {
    const machines = [machine(), machine({ machine_id: 11, machine_serial_no: 'VMC-11', run_seconds: '7200', produced: '30' })];
    queue([link(), link({ machine_id: 11 })], machines);
    const d = await svc.getOperators({ company_id });

    const derived = machines.map(m => oeeSvc.deriveOee(m, oeeSvc.DEFAULT_THRESHOLDS));
    const fleet = oeeSvc.fleetOee(derived, oeeSvc.DEFAULT_THRESHOLDS);
    const r = d.operators.data[0];
    expect(r.oee_pct).toBe(fleet.oee_pct);
    expect(r.availability_pct).toBe(fleet.availability_pct);
    expect(r.efficiency_pct).toBe(fleet.performance_pct);
    expect(r.oee_pct).toBeGreaterThan(0);
  });

  test('down time is measured idle time, not an empty table of declared reasons', async () => {
    queue();
    const d = await svc.getOperators({ company_id });
    expect(d.operators.data[0].downtime_seconds).toBe(14400);
  });
});

describe('derived rates', () => {
  const one = async (m = {}) => { queue([link()], [machine(m)]); return (await svc.getOperators({ company_id })).operators.data[0]; };

  test('good parts are produced minus rejected, never below zero', async () => {
    expect((await one()).good).toBe(95);
    resetDb();
    expect((await one({ rejected: '500' })).good).toBe(0);
  });

  test('utilisation is run over run plus idle', async () => {
    expect((await one()).utilization_pct).toBe(60);
  });

  test('rates are null, not zero, when their denominator is absent', async () => {
    const r = await one({ produced: '0', rejected: '0', run_seconds: '0', idle_seconds: '0', hours: 0 });
    expect(r.quality_rate_pct).toBeNull();
    expect(r.rejection_rate_pct).toBeNull();
    expect(r.utilization_pct).toBeNull();
    expect(r.oee_pct).toBeNull();
    expect(r.score).toBeNull();
    expect(r.band).toBe('UNRATED');
  });

  test('no cycle time: efficiency and OEE unknown, the rest still measured', async () => {
    const r = await one({ cycle_seconds: null });
    expect(r.efficiency_pct).toBeNull();
    expect(r.oee_pct).toBeNull();
    expect(r.utilization_pct).toBe(60);
    expect(r.quality_rate_pct).toBe(95);
  });

  test('numbers come back as numbers, not driver strings', async () => {
    const r = await one();
    for (const k of ['produced', 'good', 'rejected', 'run_seconds', 'idle_seconds', 'alarm_count']) {
      expect(typeof r[k]).toBe('number');
    }
  });

  test('shift and machine names are carried for the table', async () => {
    const r = await one();
    expect(r.shift_name).toBe('Morning Shift');
    expect(r.machine_names).toBe('VMC-10');
  });
});

describe('Operator Score and bands', () => {
  test('the score is the average of utilisation, efficiency and quality — whichever were measured', () => {
    expect(svc.scoreOf({ utilization_pct: 60, efficiency_pct: 90, quality_rate_pct: 90 })).toBe(80);
    expect(svc.scoreOf({ utilization_pct: 60, efficiency_pct: null, quality_rate_pct: 100 })).toBe(80);
    expect(svc.scoreOf({ utilization_pct: null, efficiency_pct: null, quality_rate_pct: null })).toBeNull();
  });

  test('zero is a real score, not a missing one', () => {
    expect(svc.scoreOf({ utilization_pct: 0, efficiency_pct: 0, quality_rate_pct: 0 })).toBe(0);
    expect(svc.bandOf(0)).toBe('NEEDS_HELP');
  });

  test('the boundaries belong to the higher band', () => {
    const { excellent, good, average } = svc.SCORE_BANDS;
    expect(svc.bandOf(excellent)).toBe('EXCELLENT');
    expect(svc.bandOf(good)).toBe('GOOD');
    expect(svc.bandOf(average)).toBe('AVERAGE');
    expect(svc.bandOf(average - 0.1)).toBe('NEEDS_HELP');
    expect(svc.bandOf(null)).toBe('UNRATED');
  });

  test('each operator counts into exactly one band, and no operators gives zeros', () => {
    const rows = [80, 65, 50, 10, null].map(score => ({ score }));
    expect(svc.band(rows)).toEqual({ excellent: 1, good: 1, average: 1, needs_help: 1, unrated: 1 });
    expect(svc.band([])).toEqual({ excellent: 0, good: 0, average: 0, needs_help: 0, unrated: 0 });
  });

  test('the response carries the bands and their thresholds', async () => {
    queue();
    const d = await svc.getOperators({ company_id });
    expect(d.score_bands).toEqual(svc.SCORE_BANDS);
    expect(Object.values(d.bands).reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('attribution is disclosed, never guessed at', () => {
  test('a shared machine is reported in full on every operator who holds it', async () => {
    queue([link({ operator_id: 1, operator_name: 'A' }), link({ operator_id: 2, operator_name: 'B' })]);
    const d = await svc.getOperators({ company_id });
    expect(d.operators.data.map(r => r.produced)).toEqual([100, 100]);
    expect(d.operators.data.every(r => r.shared_machines === 1)).toBe(true);
    expect(d.attribution.shared_machines).toBe(2);
    expect(d.attribution.note).toMatch(/more than one assigned operator/i);
  });

  test('fleet totals count a shared machine once, not once per operator', async () => {
    queue([link({ operator_id: 1 }), link({ operator_id: 2 })]);
    const d = await svc.getOperators({ company_id });
    expect(d.kpis.produced).toBe(100);
  });

  test('says how many running machines have a cycle time, which OEE needs', async () => {
    queue([link(), link({ machine_id: 11 })], [machine(), machine({ machine_id: 11, cycle_seconds: null })]);
    const d = await svc.getOperators({ company_id });
    expect(d.oee_coverage).toEqual({ machines: 2, with_cycle_time: 1 });
  });

  test('an assignment to a machine not in the totals (inactive, other company) is ignored', async () => {
    queue([link(), link({ machine_id: 999 })]);
    const d = await svc.getOperators({ company_id });
    expect(d.operators.data[0].machine_count).toBe(1);
  });
});

describe('Top 5 and Bottom 5', () => {
  const rows = [
    { operator_id: 1, operator_name: 'A', score: 90, rejection_rate_pct: 1, downtime_seconds: 100, run_seconds: 1, idle_seconds: 100, oee_pct: 50, produced: 1 },
    { operator_id: 2, operator_name: 'B', score: 70, rejection_rate_pct: 5, downtime_seconds: 900, run_seconds: 1, idle_seconds: 900, oee_pct: null, produced: 1 },
    { operator_id: 3, operator_name: 'C', score: null, rejection_rate_pct: null, downtime_seconds: 0, run_seconds: 0, idle_seconds: 0, oee_pct: null, produced: 0 },
    { operator_id: 4, operator_name: 'D', score: 40, rejection_rate_pct: 0, downtime_seconds: 300, run_seconds: 1, idle_seconds: 300, oee_pct: 20, produced: 1 }
  ];

  test('top is highest first, bottom is lowest first', () => {
    const l = svc.leaders(rows, 'score');
    expect(l.top.map(r => r.operator_name)).toEqual(['A', 'B', 'D']);
    expect(l.bottom.map(r => r.operator_name)).toEqual(['D', 'B', 'A']);
  });

  test('an operator with the measure unknown is in neither list', () => {
    expect(svc.leaders(rows, 'oee_pct').top.map(r => r.operator_name)).toEqual(['A', 'D']);
  });

  test('ranked over every operator, not the page the table shows', async () => {
    const links = Array.from({ length: 12 }, (_, i) => link({ operator_id: i + 1, operator_name: `Op${i + 1}`, machine_id: 100 + i }));
    const machines = links.map((l, i) => machine({ machine_id: l.machine_id, machine_serial_no: `M${i}`, produced: String(10 + i * 10) }));
    queue(links, machines);
    const d = await svc.getOperators({ company_id, limit: 6 });
    expect(d.operators.data).toHaveLength(6);
    const listed = [...d.leaders.score.top, ...d.leaders.score.bottom].map(r => r.operator_id);
    expect(listed.some(id => !d.operators.data.find(r => r.operator_id === id))).toBe(true);
  });

  test('downtime leaves out operators whose machines reported no time at all', async () => {
    queue([link(), link({ operator_id: 2, operator_name: 'Idle-less', machine_id: 11 })],
          [machine(), machine({ machine_id: 11, run_seconds: '0', idle_seconds: '0', produced: '0', hours: 0 })]);
    const d = await svc.getOperators({ company_id });
    expect(d.leaders.downtime.top.map(r => r.operator_id)).toEqual([1]);
  });

  test('each board carries A, P and Q for the OEE card', async () => {
    queue();
    const d = await svc.getOperators({ company_id });
    expect(Object.keys(d.leaders)).toEqual(['score', 'rejection', 'downtime', 'oee']);
    expect(d.leaders.oee.top[0]).toEqual(expect.objectContaining({
      availability_pct: expect.any(Number), efficiency_pct: expect.any(Number), quality_rate_pct: expect.any(Number)
    }));
  });
});

describe('sorting', () => {
  const rows = [
    { operator_name: 'B', score: 50, produced: 1, oee_pct: null },
    { operator_name: 'A', score: 80, produced: 1, oee_pct: 30 },
    { operator_name: 'C', score: null, produced: 1, oee_pct: 10 }
  ];

  test('by any column, either way, with unknown values last both ways', () => {
    expect(svc.sortRows(rows, 'score', 'desc').map(r => r.operator_name)).toEqual(['A', 'B', 'C']);
    expect(svc.sortRows(rows, 'score', 'asc').map(r => r.operator_name)).toEqual(['B', 'A', 'C']);
    expect(svc.sortRows(rows, 'oee_pct', 'asc').map(r => r.operator_name)).toEqual(['C', 'A', 'B']);
    expect(svc.sortRows(rows, 'operator_name', 'asc').map(r => r.operator_name)).toEqual(['A', 'B', 'C']);
  });

  test('an unknown column falls back to score, and the input is not mutated', () => {
    const copy = [...rows];
    expect(svc.sortRows(rows, 'password_hash', 'desc').map(r => r.operator_name)).toEqual(['A', 'B', 'C']);
    expect(rows).toEqual(copy);
  });

  test('the request\'s sort is echoed back, and a bad one is not', async () => {
    queue();
    expect((await svc.getOperators({ company_id, sort: 'produced', dir: 'asc' })).filters).toMatchObject({ sort: 'produced', dir: 'asc' });
    resetDb(); queue();
    expect((await svc.getOperators({ company_id, sort: '1;drop', dir: 'x' })).filters).toMatchObject({ sort: 'score', dir: 'desc' });
  });
});

describe('tenant scoping', () => {
  test('assignments and operators are scoped to the company', async () => {
    queue();
    await svc.getOperators({ company_id });
    const [assign, , options] = mockDb.calls();
    expect(assign.text).toMatch(/op\.company_id = \$1/);
    expect(assign.text).toMatch(/a\.company_id = \$1/);
    expect(assign.text).toMatch(/osa\.company_id = \$1/);
    expect(options.text).toMatch(/WHERE company_id = \$1/);
    for (const c of mockDb.calls()) expect(c.params[0]).toBe(4);
  });

  test('an assignment counts when it overlaps the period, open-ended included', async () => {
    queue();
    await svc.getOperators({ company_id, from: '2026-08-01', to: '2026-09-10' });
    const t = mockDb.calls()[0].text;
    expect(t).toMatch(/a\.assigned_from <= \$3/);
    expect(t).toMatch(/a\.assigned_to IS NULL OR a\.assigned_to >= \$2/);
  });
});

describe('every query binds exactly the parameters it references', () => {
  const refs = sql => [...String(sql).matchAll(/\$(\d+)/g)].map(m => Number(m[1]));

  test.each([
    ['no filters',  {}],
    ['machine',     { machine_id: 36 }],
    ['shift',       { shift_id: 5 }],
    ['operator',    { operator_id: 2 }],
    ['search',      { search: 'kumar' }],
    ['everything',  { from: '2026-08-01', to: '2026-09-10', machine_id: 36, shift_id: 5, operator_id: 2, search: 'a', page: 2, limit: 50 }]
  ])('%s', async (_label, filters) => {
    queue();
    await svc.getOperators({ company_id, ...filters });
    for (const call of mockDb.calls()) {
      const used = refs(call.text);
      const highest = used.length ? Math.max(...used) : 0;
      expect(call.params.length).toBe(highest);
      for (let i = 1; i <= highest; i++) expect(used).toContain(i);
    }
  });
});

describe('input validation', () => {
  test.each([['machine_id'], ['shift_id'], ['operator_id']])('%s must be a positive integer', async (field) => {
    await expect(svc.getOperators({ company_id, [field]: 'abc' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.getOperators({ company_id, [field]: '0' })).rejects.toMatchObject({ status: 400 });
  });

  test.each([['nope'], ['2026-13-01']])('rejects date %p', async (bad) => {
    await expect(svc.getOperators({ company_id, from: bad })).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a backwards range', async () => {
    await expect(svc.getOperators({ company_id, from: '2026-09-10', to: '2026-08-01' })).rejects.toMatchObject({ status: 400 });
  });

  test('search is parameterised, never interpolated', async () => {
    queue();
    await svc.getOperators({ company_id, search: "'; DROP TABLE operators;--" });
    expect(mockDb.calls()[0].text).not.toMatch(/DROP TABLE/);
    expect(mockDb.calls()[0].params).toContain("%'; DROP TABLE operators;--%");
  });

  test('caps the page size', async () => {
    queue();
    expect((await svc.getOperators({ company_id, limit: 99999 })).operators.limit).toBe(200);
  });
});

describe('export', () => {
  test('carries the table\'s columns, in its order', async () => {
    queue();
    const rows = await svc.getExportRows({ company_id });
    expect(Object.keys(rows[0])).toEqual([
      'Operator ID', 'Operator', 'Shift', 'Machines', 'Shared', 'Score', 'Run time', 'Down time',
      'Utilization', 'Produced', 'Good', 'Rejected', 'Quality rate', 'Alarms', 'OEE', 'Efficiency', 'Status'
    ]);
  });

  test('an unmeasured rate exports blank rather than a misleading zero', async () => {
    queue([link()], [machine({ cycle_seconds: null })]);
    const [r] = await svc.getExportRows({ company_id });
    expect(r.OEE).toBe('');
    expect(r.Efficiency).toBe('');
  });

  test('marks which operators share machines', async () => {
    queue([link({ operator_id: 1 }), link({ operator_id: 2, operator_name: 'B' })]);
    const rows = await svc.getExportRows({ company_id });
    expect(rows.every(r => r.Shared === '1 shared')).toBe(true);
  });
});
