/*
 * Unit tests for dashboard/maintenance.service — Phase 2 Screen 2.
 *
 * Two of these guard bugs found while building it against real data:
 *
 *   - every telemetry_raw read must bound received_at. It is a Timescale
 *     hypertable with ~180 chunks; unbounded, the DISTINCT ON had not
 *     finished after 227 seconds on production.
 *   - the operator lookup must be a LATERAL, not a join. Machines carry
 *     several active operator assignments (one has three), and a plain join
 *     emitted that machine once per operator.
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/dashboard/maintenance.service');

const company_id = 4;
const req = (query = {}) => ({ user: { company_id }, query: { date: '2026-08-06', ...query } });

/** The six queries the dashboard fires, in Promise.all order. */
const queueAll = (over = {}) => mockDb.queueResponse(
  { rows: [over.health || { total: 20, running: 12, idle: 6, breakdown: 1, offline: 1 }] },
  { rows: over.rows   || [{ machine_id: 1, machine_serial_no: 'VMC-1' }] },
  { rows: over.alarms || [] },
  { rows: [over.oee   || { availability: 90, performance: 80, quality: 99, oee: 71 }] },
  { rows: [over.prod  || { produced: 100, run_seconds: 3600, idle_seconds: 600 }] },
  { rows: over.trend  || [] }
);

const sqlOf = (i) => mockDb.calls()[i].text;

beforeEach(() => resetDb());

describe('maintenance dashboard — query safety', () => {

  test('every telemetry_raw read bounds received_at', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());

    const telemetry = mockDb.calls().filter(c => /telemetry_raw/.test(c.text));
    expect(telemetry.length).toBeGreaterThan(0);
    telemetry.forEach(c => {
      // without this the planner cannot prune chunks and the query is unusable
      expect(c.text).toMatch(/received_at > NOW\(\) - INTERVAL '1 hour'/);
    });
  });

  test('the operator lookup is a LATERAL so a machine cannot repeat', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());

    const rowsSql = sqlOf(1);
    expect(rowsSql).toMatch(/LEFT JOIN LATERAL/);
    expect(rowsSql).toMatch(/LIMIT 1/);
    // a bare join against the assignment table is the bug this replaced
    expect(rowsSql).not.toMatch(/LEFT JOIN operator_machine_assignments/);
  });

  test('the cycle-time trend cannot divide by a zero part count', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());
    expect(sqlOf(5)).toMatch(/NULLIF\(SUM\(produced_qty\),0\)/);
  });

  test('every query is scoped to the caller’s company', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());
    mockDb.calls().forEach(c => expect(c.params[0]).toBe(company_id));
  });
});

describe('maintenance dashboard — shaping', () => {

  test('health is reporting-and-not-alarming, as a percentage', async () => {
    queueAll({ health: { total: 20, running: 12, idle: 6, breakdown: 1, offline: 1 } });

    const res = await svc.getMaintenanceDashboard(req());

    expect(res.health).toMatchObject({ healthy: 18, unhealthy: 2, percent: 90 });
    // the definition travels with the number — the agreement never fixed one
    expect(res.health.basis).toMatch(/not in alarm/i);
  });

  test('health does not divide by zero when a company has no machines', async () => {
    queueAll({ health: { total: 0, running: 0, idle: 0, breakdown: 0, offline: 0 } });

    const res = await svc.getMaintenanceDashboard(req());

    expect(res.health.percent).toBe(0);
    expect(Number.isNaN(res.health.percent)).toBe(false);
  });

  test('alarm severities collapse into the three agreed classes', async () => {
    queueAll({ alarms: [
      { class: 'CRITICAL',     total: 3, open: 2 },
      { class: 'NON_CRITICAL', total: 5, open: 1 },
      { class: 'INFORMATION',  total: 2, open: 0 }
    ] });

    const res = await svc.getMaintenanceDashboard(req());

    expect(res.alarms).toEqual({
      total: 10, open: 3, critical: 3, non_critical: 5, information: 2
    });
  });

  test('an empty alarm table reports zeros rather than undefined', async () => {
    queueAll({ alarms: [] });
    const res = await svc.getMaintenanceDashboard(req());
    expect(res.alarms).toEqual({ total: 0, open: 0, critical: 0, non_critical: 0, information: 0 });
  });

  test('names the signals it cannot show, so the UI need not guess', async () => {
    queueAll();
    const res = await svc.getMaintenanceDashboard(req());

    // servo/temperature/battery/insulation/fan are not collected by anything
    expect(res.unavailable).toEqual(expect.arrayContaining([
      'servo_load_per_axis', 'machine_temperature', 'battery_status',
      'insulation_resistance', 'fan_amplifier_status'
    ]));
  });

  test('missing rollup rows degrade to nulls instead of throwing', async () => {
    mockDb.queueResponse(
      { rows: [] },   // health — no row at all
      { rows: [] },
      { rows: [] },
      { rows: [] },   // oee
      { rows: [] },   // production
      { rows: [] }
    );

    const res = await svc.getMaintenanceDashboard(req());

    expect(res.machines).toMatchObject({ total: 0 });
    expect(res.oee.oee).toBeNull();
    expect(res.production.produced).toBe(0);
  });
});

describe('maintenance dashboard — filters', () => {

  test('a machine filter is applied to the telemetry, rollup and row queries', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req({ machine_id: '7' }));

    const rowsSql = sqlOf(1);
    expect(rowsSql).toMatch(/AND m\.id = \$4/);
    expect(rowsSql).toMatch(/AND t\.machine_id = \$4/);
    expect(mockDb.calls()[1].params).toContain(7);
  });

  test('the resolved filters come back so the UI can echo them', async () => {
    queueAll();
    const res = await svc.getMaintenanceDashboard(req({ machine_id: '7' }));

    expect(res.filters).toMatchObject({ date: '2026-08-06', machine_id: 7, shift_id: null });
    expect(res.updated_at).toBeTruthy();
  });
});
