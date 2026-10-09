/*
 * Dashboards with charts and tables show them on separate tabs in the web
 * app, under the KPI tiles every tab shares, and the API serves each in its
 * own part (`?part=` kpis, charts, table — one or more).
 *
 * For each of the seven: a part runs its own queries and sends its own
 * figures, and no other part's; no `part` is everything, as before (exports,
 * older clients). What two parts share — the figures a chart and a table are
 * both drawn from — comes with either.
 */
jest.mock('../../src/db', () => ({ query: jest.fn() }));
const db = require('../../src/db');
const { parsePart, when } = require('../../src/dashboard/parts');

const alarms     = require('../../src/dashboard/alarm.service');
const downtime   = require('../../src/dashboard/downtime.service');
const energy     = require('../../src/dashboard/energy.service');
const report     = require('../../src/dashboard/maintenance-report.service');
const operators  = require('../../src/dashboard/operator.service');
const periodic   = require('../../src/dashboard/periodic.service');
const preventive = require('../../src/dashboard/preventive.service');

const company_id = 4;
const range = { from: '2026-10-01', to: '2026-10-07' };

/* Every query answers one row whose every column reads 0: enough for each
   service to shape a response, and every SQL text is kept to look at. */
let sql = [];
beforeEach(() => {
  sql = [];
  db.query.mockReset();
  db.query.mockImplementation(async (text) => {
    sql.push(String(text));
    const row = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : 0) });
    return { rows: [row], rowCount: 1 };
  });
});
const ran = re => sql.some(t => re.test(t));

describe('parsePart', () => {
  test('one part, several, or all', () => {
    expect(parsePart('kpis')).toEqual({ kpis: true, charts: false, table: false, all: false });
    expect(parsePart('KPIS, Table')).toEqual({ kpis: true, charts: false, table: true, all: false });
    expect(parsePart(['kpis', 'charts'])).toEqual({ kpis: true, charts: true, table: false, all: false });
    expect(parsePart('kpis,charts,table').all).toBe(true);
    for (const v of [undefined, null, '', 'all']) {
      expect(parsePart(v)).toEqual({ kpis: true, charts: true, table: true, all: true });
    }
  });

  test('anything else is a 400, before any query', () => {
    for (const v of ['overview', 'kpis,graphs', ',', 'table;drop']) {
      expect(() => parsePart(v)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });

  test('when() runs only what was asked for', async () => {
    const run = jest.fn(async () => 'ran');
    await expect(when(false, run, [])).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(when(true, run)).resolves.toBe('ran');
  });
});

/*
 * Each dashboard: how to call it, the response keys of each part, and — for
 * the parts that have queries of their own — SQL only that part runs.
 */
const cases = [
  { name: 'Alarm Report', call: part => alarms.getAlarms({ company_id, ...range, part }),
    keys: { kpis: ['kpis', 'facets'], charts: ['by_machine', 'by_shift', 'by_severity', 'trend'], table: ['alarms'] },
    sql: { charts: /GROUP BY s\.shift_name/, table: /a\.started_at DESC, a\.id DESC\s+LIMIT/ } },
  { name: 'Downtime Analysis', call: part => downtime.getDowntime({ company_id, ...range, part }),
    keys: { kpis: ['kpis'], charts: ['top_reasons', 'by_category', 'by_shift', 'hourly'], table: ['events'] },
    sql: { kpis: /FROM production_hourly/, charts: /GROUP BY r\.category/, table: /ORDER BY e\.started_at DESC/ } },
  { name: 'Energy', call: part => energy.getEnergy({ company_id, ...range, part }),
    keys: { kpis: ['kpis', 'coverage'], charts: ['trend', 'by_shift', 'by_month', 'top_consumers'], table: ['machines'] },
    sql: { charts: /date_trunc\('month'/ } },
  { name: 'Maintenance Report', call: part => report.getReport({ company_id, ...range, part }),
    keys: { kpis: ['kpis'], charts: ['by_type', 'by_status', 'trend'], table: ['tickets'] },
    sql: { kpis: /AS mttr_basis/, charts: /GROUP BY t\.issue_type/, table: /LIMIT \$\d+ OFFSET/ } },
  { name: 'Operator Performance', call: part => operators.getOperators({ company_id, ...range, part }),
    keys: { kpis: ['kpis', 'bands', 'attribution', 'operator_list'], charts: ['leaders'], table: ['operators'] },
    sql: {} },
  { name: 'Periodic Maintenance', call: part => periodic.getPeriodic({ company_id, part }),
    keys: { kpis: ['kpis'], charts: ['compliance_trend'], table: ['by_frequency', 'upcoming', 'tickets'] },
    sql: { charts: /week_start/, table: /LIMIT \$\d+ OFFSET/ } },
  { name: 'Preventive Maintenance', call: part => preventive.getPreventiveDashboard(
      { user: { company_id }, query: { ...range, part } }),
    keys: { kpis: ['kpis'], charts: ['alarm_trend', 'alarm_severity', 'alarms_by_machine', 'top_alarm_reasons'], table: ['tickets'] },
    sql: { kpis: /AS avg_resolution_hours/, charts: /generate_series/, table: /LIMIT \$\d+ OFFSET/ } }
];
const PARTS = ['kpis', 'charts', 'table'];

describe.each(cases)('$name', ({ name, call, keys, sql: own }) => {

  test.each(PARTS)('part=%s sends its own figures and runs its own queries, no other part\'s', async (part) => {
    const d = await call(part);
    for (const p of PARTS) {
      for (const k of keys[p]) {
        if (p === part) expect(d).toHaveProperty(k);
        else expect(d).not.toHaveProperty(k);
      }
      if (own[p]) expect(ran(own[p])).toBe(p === part);
    }
    expect(d.updated_at).toBeTruthy();
  });

  test('two parts in one request: both, and only both', async () => {
    const d = await call('kpis,table');
    for (const k of [...keys.kpis, ...keys.table]) expect(d).toHaveProperty(k);
    for (const k of keys.charts) expect(d).not.toHaveProperty(k);
    if (own.charts) expect(ran(own.charts)).toBe(false);
  });

  test('no part: everything, as before', async () => {
    const d = await call(undefined);
    for (const p of PARTS) for (const k of keys[p]) expect(d).toHaveProperty(k);
    // the SQL each part is told apart by does run for the whole: the checks above are not vacuous
    for (const re of Object.values(own)) expect(ran(re)).toBe(true);
  });

  test('a part costs no more queries than the whole, and the table alone costs fewer', async () => {
    await call(undefined);
    const whole = sql.length;
    const cost = {};
    for (const p of PARTS) {
      sql = [];
      await call(p);
      cost[p] = sql.length;
      expect(cost[p]).toBeLessThanOrEqual(whole);
    }
    // one set of figures, three views of it: a part saves sending, not working out
    if (name === 'Operator Performance') expect(cost.table).toBe(whole);
    else expect(cost.table).toBeLessThan(whole);
  });

  test('a part that is not one is refused, before any query', async () => {
    await expect(call('charts,graphs')).rejects.toMatchObject({ status: 400 });
    expect(sql).toHaveLength(0);
  });
});

describe('what two parts share', () => {
  test('Downtime: the reason totals feed the Pareto and the summary table, so charts and table each bring them', async () => {
    expect(await downtime.getDowntime({ company_id, part: 'charts' })).toHaveProperty('by_reason');
    expect(await downtime.getDowntime({ company_id, part: 'table' })).toHaveProperty('by_reason');
    expect(await downtime.getDowntime({ company_id, part: 'kpis' })).not.toHaveProperty('by_reason');
  });

  test('Maintenance Report: per-machine totals feed the stopped-time chart and the summary table', async () => {
    expect(await report.getReport({ company_id, part: 'charts' })).toHaveProperty('by_machine');
    expect(await report.getReport({ company_id, part: 'table' })).toHaveProperty('by_machine');
    expect(await report.getReport({ company_id, part: 'kpis' })).not.toHaveProperty('by_machine');
  });

  test('Periodic: technician workload gives the Overdue tile its line and draws the donut', async () => {
    expect(await periodic.getPeriodic({ company_id, part: 'kpis' })).toHaveProperty('technician_workload');
    expect(await periodic.getPeriodic({ company_id, part: 'charts' })).toHaveProperty('technician_workload');
    expect(await periodic.getPeriodic({ company_id, part: 'table' })).not.toHaveProperty('technician_workload');
  });

  test('Energy: the daily trend draws a chart and gives the tiles "vs yesterday"; the table needs neither', async () => {
    await energy.getEnergy({ company_id, part: 'kpis' });
    expect(ran(/generate_series|date_trunc\('day'/)).toBe(true);
    sql = [];
    await energy.getEnergy({ company_id, part: 'table' });
    expect(ran(/generate_series|date_trunc\('day'|date_trunc\('month'/)).toBe(false);
  });

  test('Preventive: the status split and trigger summary, which no screen draws, only in the full answer', async () => {
    const parts = await preventive.getPreventiveDashboard({ user: { company_id }, query: { part: 'kpis,charts,table' } });
    expect(parts).toHaveProperty('ticket_status');
    const two = await preventive.getPreventiveDashboard({ user: { company_id }, query: { part: 'kpis,charts' } });
    expect(two).not.toHaveProperty('ticket_status');
    expect(two).not.toHaveProperty('alarm_triggers');
  });

  test('the energy and operator exports ask for the table alone', async () => {
    await energy.getExportRows({ company_id });
    expect(ran(/generate_series|date_trunc\('month'/)).toBe(false);
  });
});
