/*
 * A dashboard tile opens the records behind its number: the details table
 * (and its export) is narrowed by the tile's own definition, so the table's
 * total is the number on the tile; the tiles and charts keep the whole
 * picture; a value that is not a tile is refused before any query; the same
 * tile again (show=all, or none) is everything, as before.
 */
/* Queued answers first; after them every query answers one row whose every
   column reads 0 — enough for each service to shape a response. */
jest.mock('../../src/db', () => {
  const state = { calls: [], queue: [] };
  const zero = () => new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : 0) });
  const query = jest.fn(async (text, params) => {
    state.calls.push({ text: String(text), params });
    if (state.queue.length) {
      const next = state.queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }
    return { rows: [zero()], rowCount: 1 };
  });
  return { query, __state: state };
});
const db = require('../../src/db');
const mockDb = {
  calls: () => db.__state.calls,
  queueResponse: (...r) => db.__state.queue.push(...r)
};
const resetDb = () => { db.__state.calls.length = 0; db.__state.queue.length = 0; };
const report = require('../../src/dashboard/maintenance-report.service');
const preventive = require('../../src/dashboard/preventive.service');
const periodic = require('../../src/dashboard/periodic.service');
const operators = require('../../src/dashboard/operator.service');
const energy = require('../../src/dashboard/energy.service');

const company_id = 4;
const range = { from: '2026-10-01', to: '2026-10-07' };
const sqlWith = re => mockDb.calls().filter(c => re.test(c.text));

beforeEach(() => resetDb());

describe('Maintenance Report', () => {
  test.each([
    ['open',     /NOT \(t\.status IN \('RESOLVED','CLOSED'\)\)/],
    ['settled',  /AND t\.status IN \('RESOLVED','CLOSED'\)/],
    ['repaired', /AND t\.resolved_at IS NOT NULL/],
    ['downtime', /AND t\.downtime_minutes IS NOT NULL/]
  ])('show=%s narrows the ticket list (rows and total), not the tiles', async (show, clause) => {
    await report.getReport({ company_id, ...range, show, part: 'kpis,table' });
    const list = sqlWith(/AS repair_hours|COUNT\(\*\)::int AS n\b/);
    expect(list).toHaveLength(2);
    for (const q of list) expect(q.text).toMatch(clause);
    const tiles = sqlWith(/AS mttr_basis/);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].text).not.toMatch(clause);
  });

  test('the export is the narrowed list too', async () => {
    await report.getExportRows({ company_id, ...range, show: 'open' });
    expect(mockDb.calls().every(c => /NOT \(t\.status IN \('RESOLVED','CLOSED'\)\)/.test(c.text))).toBe(true);
  });

  test('anything else is a 400, before any query; all is everything', async () => {
    await expect(report.getReport({ company_id, ...range, show: 'everything' })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
    await report.getReport({ company_id, ...range, show: 'all', part: 'table' });
    expect(mockDb.calls().some(c => /RESOLVED','CLOSED/.test(c.text))).toBe(false);
  });
});

describe('Preventive Maintenance', () => {
  const req = query => ({ user: { company_id }, query: { ...range, ...query } });

  test.each([
    ['open',      /t\.status IN \('OPEN','ASSIGNED','IN_PROGRESS'\)/],
    ['completed', /t\.status IN \('RESOLVED','CLOSED'\)/],
    ['resolved',  /t\.resolved_at IS NOT NULL/],
    ['raised',    /AND TRUE/]
  ])('show=%s: the PM tickets raised in the range, as the tiles count them', async (show, clause) => {
    await preventive.getPreventiveDashboard(req({ show, part: 'table' }));
    const [rows, count] = [sqlWith(/AS ticket_id/)[0], sqlWith(/SELECT COUNT\(\*\)::int AS total/)[0]];
    for (const q of [rows, count]) {
      expect(q.text).toMatch(clause);
      expect(q.text).toMatch(/t\.created_at >= \$\d+ AND t\.created_at <= \$\d+/);
    }
    // bounded by the same instants the tiles use
    expect(count.params.slice(-2)).toEqual(rows.params.slice(-5, -3));
    for (const q of [rows, count]) {
      const used = Math.max(...[...q.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
      expect(q.params).toHaveLength(used);
    }
  });

  test('without a tile the list is the backlog, not bounded by the dates', async () => {
    await preventive.getPreventiveDashboard(req({ part: 'table' }));
    expect(sqlWith(/AS ticket_id/)[0].text).not.toMatch(/t\.created_at >=/);
  });

  test('anything else is a 400, before any query', async () => {
    await expect(preventive.getPreventiveDashboard(req({ show: 'nope' }))).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('Periodic Maintenance', () => {
  test('the Completed tile: due=completed lists the done tickets', async () => {
    await periodic.getPeriodic({ company_id, part: 'table', due: 'completed' });
    // the list's rows and its total
    const list = sqlWith(/AS completed_at|SELECT COUNT\(\*\)::int AS total/);
    expect(list).toHaveLength(2);
    for (const q of list) {
      expect(q.text).toMatch(/t\.status = ANY\(\$\d+\)/);
      expect(q.params).toContainEqual(['RESOLVED', 'CLOSED']);
    }
  });

  test('Due Today counts the plant\'s calendar day, as the list does', async () => {
    await periodic.getPeriodic({ company_id, part: 'kpis' });
    expect(sqlWith(/AS due_today/)[0].text)
      .toMatch(/\(due_date AT TIME ZONE 'Asia\/Kolkata'\)::date = \(NOW\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date/);
  });
});

describe('Operator Performance', () => {
  const link = (id, machine) => ({ operator_id: id, operator_code: `OP${id}`, operator_name: `Op ${id}`, skill_level: 'L2', machine_id: machine, shift_name: 'S1' });
  const machine = (id, over) => ({ machine_id: id, machine_serial_no: `M-${id}`, model: 'V', run_seconds: '21600', idle_seconds: '1000',
    produced: '100', hours: 10, cycle_seconds: '180', mult: '1', rejected: '0', alarm_count: 0, downtime_seconds: '0',
    machine_status: 'RUNNING', alarm: false, ...over });
  const queue = () => mockDb.queueResponse(
    { rows: [link(1, 10), link(2, 11)] },
    { rows: [machine(10), machine(11, { run_seconds: '600', idle_seconds: '30000', produced: '1' })] },
    { rows: [] });

  test('a band tile lists that band\'s operators; the total is the tile\'s number', async () => {
    queue();
    const all = await operators.getOperators({ company_id, ...range });
    for (const show of ['excellent', 'good', 'average', 'needs_help']) {
      resetDb(); queue();
      const d = await operators.getOperators({ company_id, ...range, show });
      expect(d.operators.total).toBe(all.bands[show]);
      expect(d.operators.data.every(r => r.band === show.toUpperCase())).toBe(true);
      expect(d.bands).toEqual(all.bands);           // the tiles keep every operator
    }
  });

  test('anything else is a 400, before any query', async () => {
    await expect(operators.getOperators({ company_id, show: 'stars' })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});

describe('Energy', () => {
  test('Overload Alerts lists the overloaded machines; the tiles keep every machine', async () => {
    const settings = [{ machine_id: null, cost_per_kwh: null, currency: 'INR', overload_kw: '50' }];
    const machines = [
      { machine_id: 1, machine_serial_no: 'A', model: 'x', run_seconds: '1', produced: '1', peak_kw: '60' },
      { machine_id: 2, machine_serial_no: 'B', model: 'x', run_seconds: '1', produced: '1', peak_kw: '20' }
    ];
    // the settings, the counter pass, the machines' figures
    mockDb.queueResponse({ rows: settings }, { rows: [] }, { rows: machines });
    const d = await energy.getEnergy({ company_id, ...range, part: 'kpis,table', show: 'overload' });
    expect(d.kpis.overload_alerts).toBe(1);
    expect(d.machines.total).toBe(1);
    expect(d.machines.data.map(m => m.machine_serial_no)).toEqual(['A']);
  });

  test('anything else is a 400, before any query', async () => {
    await expect(energy.getEnergy({ company_id, show: 'hot' })).rejects.toMatchObject({ status: 400 });
    expect(mockDb.calls()).toHaveLength(0);
  });
});
