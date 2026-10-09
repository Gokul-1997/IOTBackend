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
  { rows: [over.prod  || { produced: 100, run_seconds: 3600, idle_seconds: 600 }] }
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
      // either the live freshness window or the dashboard's own date window
      expect(c.text).toMatch(/received_at > NOW\(\) - INTERVAL '1 hour'|received_at >= \$2 AND t\.received_at < \$3/);
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

  test('names the signals no machine reported, measured from the rows', async () => {
    // a machine reporting only servo load and temperature, like the
    // embedded team's sample
    queueAll({ rows: [{ machine_id: 1, machine_serial_no: 'VMC-1',
                        servo_load_x: 5, servo_temp_x: 27, spindle_motor_temp: 36 }] });
    const res = await svc.getMaintenanceDashboard(req());

    expect(res.unavailable).toEqual(expect.arrayContaining([
      'encoder_temperature', 'battery_status', 'insulation_resistance', 'fan_amplifier_status'
    ]));
    expect(res.unavailable).not.toContain('servo_load_per_axis');
    expect(res.unavailable).not.toContain('servo_temperature');
    expect(res.unavailable).not.toContain('spindle_temperature');
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

/*
 * Machine condition signals (migration 021).
 */
describe('maintenance dashboard — condition signals', () => {
  const { unavailableSignals, SIGNAL_COLUMNS } = svc;

  test('the live row query reads every condition column', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());
    const rowsSql = sqlOf(1);
    for (const cols of Object.values(SIGNAL_COLUMNS)) {
      for (const c of cols) expect(rowsSql).toContain(`l.${c}`);
    }
  });

  test('one axis on one machine is enough for a signal to be available', () => {
    // "temperature is available for 1 servo": Y and Z silent, X reporting
    const rows = [{ servo_temp_x: null }, { servo_temp_x: null, servo_temp_z: 41 }];
    expect(unavailableSignals(rows)).not.toContain('servo_temperature');
  });

  test('a genuine 0 counts as a reading', () => {
    expect(unavailableSignals([{ servo_load_x: 0 }])).not.toContain('servo_load_per_axis');
  });

  test('before migration 032 the battery flags read as NULL instead of failing the screen', async () => {
    const missing = Object.assign(new Error('column t.apc_battery_status does not exist'), { code: '42703' });
    mockDb.queueResponse({ rows: [{ total: 1, running: 1, idle: 0, breakdown: 0, offline: 0 }] });
    mockDb.queueError(missing);
    mockDb.queueResponse({ rows: [] }, { rows: [] }, { rows: [{ produced: 0, run_seconds: 0, idle_seconds: 0 }] },
                         { rows: [{ machine_id: 1, machine_serial_no: 'VMC-1', apc_battery_status: null }] });

    const res = await svc.getMaintenanceDashboard(req());

    const latest = mockDb.calls().filter(c => /WITH latest AS[\s\S]*fan_status/.test(c.text));
    expect(latest).toHaveLength(2);
    expect(latest[0].text).toContain('t.apc_battery_status');
    expect(latest[1].text).toContain('NULL::jsonb AS apc_battery_status');
    expect(res.rows).toEqual([{ machine_id: 1, machine_serial_no: 'VMC-1', apc_battery_status: null }]);
  });

  test('any other database error still fails the screen', async () => {
    mockDb.queueResponse({ rows: [{ total: 1, running: 1, idle: 0, breakdown: 0, offline: 0 }] });
    mockDb.queueError(Object.assign(new Error('column t.fan_status does not exist'), { code: '42703' }));
    await expect(svc.getMaintenanceDashboard(req())).rejects.toThrow('fan_status');
  });

  test('battery flags per axis, with no voltage, make the battery available', () => {
    // 192.168.200.1 since Oct 2026: `battery: {X: false, ...}` and no volts
    const rows = [{ cnc_battery_voltage: null, apc_battery_voltage: null,
                    apc_battery_status: { X: false, Y: false, Z: false },
                    fan_status: { CNC_FAN1: { on: true, fault: false, rpm: 10206 } } }];
    expect(unavailableSignals(rows)).not.toContain('battery_status');
    expect(unavailableSignals(rows)).not.toContain('fan_amplifier_status');
  });

  test('no rows means every signal is unavailable, and bad input does not throw', () => {
    const all = Object.keys(SIGNAL_COLUMNS);
    expect(unavailableSignals([])).toEqual(all);
    expect(unavailableSignals(null)).toEqual(all);
    expect(unavailableSignals([null, undefined])).toEqual(all);
  });

  test('no machine selected: the condition trend is not queried at all', async () => {
    queueAll();
    const res = await svc.getMaintenanceDashboard(req());
    // averaging servo temperatures across a fleet describes no motor, and it
    // is the most expensive scan the screen could run
    expect(mockDb.calls().some(c => /date_trunc\('hour', t\.received_at\)/.test(c.text))).toBe(false);
    expect(res.condition_trend).toEqual([]);
  });

  test('one machine selected: the trend is bounded, scoped and binds exactly its parameters', async () => {
    queueAll();
    mockDb.queueResponse({ rows: [{ hour_start: '2026-08-06T09:00:00Z', servo_temp_x: 27 }] });
    const res = await svc.getMaintenanceDashboard(req({ machine_id: '7' }));

    const call = mockDb.calls().find(c => /date_trunc\('hour', t\.received_at\)/.test(c.text));
    expect(call).toBeTruthy();
    expect(call.text).toMatch(/t\.received_at >= \$2 AND t\.received_at < \$3/);
    expect(call.text).toMatch(/m\.company_id = \$1/);
    expect(call.text).toMatch(/t\.machine_id = \$4/);

    // Postgres rejects a statement given more parameters than it references
    const highest = Math.max(...[...call.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    expect(call.params.length).toBe(highest);
    expect(call.params[0]).toBe(company_id);
    expect(call.params[3]).toBe(7);

    expect(res.condition_trend).toEqual([{ hour_start: '2026-08-06T09:00:00Z', servo_temp_x: 27 }]);
  });
});

/*
 * The screen as the design draws it (2026-09-29): the selected machine's
 * last reading of the day, its photo, and cycle time hour by hour.
 */
describe('maintenance dashboard — machine card and cycle time', () => {

  test('one machine selected: its readings are the latest within the day, not the last hour', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req({ machine_id: '7' }));
    const rowsSql = sqlOf(1);
    // a machine that stopped at 6 pm still shows its last condition at 8 pm
    expect(rowsSql).toMatch(/t\.machine_id = \$4 AND t\.received_at >= \$2 AND t\.received_at < \$3/);
    expect(rowsSql).not.toMatch(/NOW\(\) - INTERVAL '1 hour'/);
  });

  test('no machine selected: the fleet readings keep the one-hour bound', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());
    expect(sqlOf(1)).toMatch(/received_at > NOW\(\) - INTERVAL '1 hour'/);
  });

  test('the machine card gets the machine photo', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());
    expect(sqlOf(1)).toMatch(/m\.image_url/);
  });

  test('cycle time is queried only for one machine, bounded to the window', async () => {
    queueAll();
    await svc.getMaintenanceDashboard(req());
    expect(mockDb.calls().some(c => /GROUP BY hour_start ORDER BY hour_start/.test(c.text))).toBe(false);

    resetDb();
    queueAll();
    mockDb.queueResponse({ rows: [] }); // condition trend
    await svc.getMaintenanceDashboard(req({ machine_id: '7' }));
    const call = mockDb.calls().find(c => /GROUP BY hour_start ORDER BY hour_start/.test(c.text));
    expect(call).toBeTruthy();
    expect(call.text).toMatch(/hour_start >= \$2 AND hour_start < \$3 AND machine_id = \$4/);
    const highest = Math.max(...[...call.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    expect(call.params.length).toBe(highest);
    expect(call.params[0]).toBe(company_id);
  });

  test('cycle time is run time per part; an hour with no part has none, not zero', () => {
    expect(svc.cycleTrend([
      { hour_start: 'h1', produced: 2, run_seconds: 97 },
      { hour_start: 'h2', produced: 0, run_seconds: 3600 },
      { hour_start: 'h3', produced: '3', run_seconds: '150' }
    ])).toEqual([
      { hour_start: 'h1', produced: 2, cycle_seconds: 48.5 },
      { hour_start: 'h2', produced: 0, cycle_seconds: null },
      { hour_start: 'h3', produced: 3, cycle_seconds: 50 }
    ]);
    expect(svc.cycleTrend(null)).toEqual([]);
  });
});

/*
 * The supply voltage (Oct 2026, the embedded team: "PowerData has LN and LL
 * parameters — use them separately for voltage"). From the machine's energy
 * meter, the latest reading in the day or shift; only VMC - 2 - F has one.
 */
describe('maintenance dashboard — supply voltage', () => {
  const supplyCall = () => mockDb.calls().find(c => /FROM energy_meter_readings/.test(c.text));
  const reading = { read_at: '2026-10-09T06:30:15Z', v1n: 242.3, v2n: 243.79, v3n: 242.22, v_ln_avg: 242.77,
                    v12: 421.2, v23: 421.16, v31: 419.12, v_ll_avg: 420.49 };

  test('no machine selected: no meter query, no supply', async () => {
    queueAll();
    const res = await svc.getMaintenanceDashboard(req());
    expect(supplyCall()).toBeUndefined();
    expect(res.supply).toBeNull();
  });

  test('one machine: its latest reading in the window, scoped to the company, binding exactly its parameters', async () => {
    queueAll();
    mockDb.queueResponse({ rows: [] }, { rows: [] }, { rows: [reading] });   // trend, cycle time, supply
    const res = await svc.getMaintenanceDashboard(req({ machine_id: '19' }));

    const call = supplyCall();
    expect(call.text).toMatch(/m\.company_id = \$1/);
    expect(call.text).toMatch(/r\.machine_id = \$4 AND r\.read_at >= \$2 AND r\.read_at < \$3/);
    expect(call.text).toMatch(/ORDER BY r\.read_at DESC\s+LIMIT 1/);
    const highest = Math.max(...[...call.text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    expect(call.params.length).toBe(highest);
    expect(call.params[0]).toBe(company_id);
    expect(call.params[3]).toBe(19);

    // two groups, as the meter sends them
    expect(res.supply.ln).toEqual({ v1n: 242.3, v2n: 243.79, v3n: 242.22, avg: 242.77 });
    expect(res.supply.ll).toEqual({ v12: 421.2, v23: 421.16, v31: 419.12, avg: 420.49 });
    expect(res.supply.limits).toEqual({ ll_nominal: 415, ln_nominal: 240, tolerance_pct: 10, imbalance_pct: 2 });
  });

  test('a machine without a meter, or a database before migration 029, has no supply — not an error', async () => {
    queueAll();
    mockDb.queueResponse({ rows: [] }, { rows: [] }, { rows: [] });
    expect((await svc.getMaintenanceDashboard(req({ machine_id: '20' }))).supply).toBeNull();

    resetDb();
    queueAll();
    mockDb.queueResponse({ rows: [] }, { rows: [] });
    mockDb.queueError(Object.assign(new Error('relation "energy_meter_readings" does not exist'), { code: '42P01' }));
    expect((await svc.getMaintenanceDashboard(req({ machine_id: '20' }))).supply).toBeNull();
  });

  test('a reading older than two minutes is marked stale; values come back as numbers', () => {
    const now = Date.parse('2026-10-09T06:40:00Z');
    expect(svc.supplyOf({ ...reading, v1n: '242.3' }, now)).toMatchObject({ stale: true, ln: { v1n: 242.3 } });
    expect(svc.supplyOf(reading, Date.parse('2026-10-09T06:31:00Z')).stale).toBe(false);
    expect(svc.supplyOf({ ...reading, v2n: null }, now).ln.v2n).toBeNull();
    expect(svc.supplyOf(undefined)).toBeNull();
  });
});
