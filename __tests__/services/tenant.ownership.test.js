/*
 * Every id a request names must belong to the caller's company.
 *
 * tools/loadtest/multitenant/probe.mjs called every route as one company with
 * another company's ids and found three reads and nine writes that crossed
 * over (quality, charts, components, operators, assignments, tickets,
 * maintenance, downtime). Each is pinned here: the other company's id is
 * refused with 404 before anything is read or written.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { ownedOrThrow } = require('../../src/lib/tenant');

beforeEach(() => resetDb());

const writes = () => mockDb.calls().filter(c => /\b(INSERT|UPDATE|DELETE)\b/i.test(c.text));

describe('ownedOrThrow', () => {
  const client = rows => ({ query: jest.fn(async () => ({ rows })) });

  test('one query for every kind of id, scoped to the company', async () => {
    const c2 = client([{ k: 0, n: 1 }, { k: 1, n: 1 }]);
    await ownedOrThrow(4, { machine_id: 7, shift_id: undefined, machine_ids: [], operator_id: '9' }, c2);
    expect(c2.query).toHaveBeenCalledTimes(1);
    const [sql, params] = c2.query.mock.calls[0];
    expect(sql).toMatch(/FROM machines WHERE id = ANY\(\$2::int\[\]\)\s+AND company_id = \$1/);
    expect(sql).toMatch(/FROM operators WHERE id = ANY\(\$3::int\[\]\)/);
    expect(params).toEqual([4, [7], [9]]);
  });

  test('an id of another company is a 404 naming what was not found', async () => {
    await expect(ownedOrThrow(4, { machine_id: 7, shift_id: 3 }, client([{ k: 0, n: 1 }, { k: 1, n: 0 }])))
      .rejects.toEqual({ status: 404, message: 'Shift not found' });
  });

  test('a list counts every id, duplicates once', async () => {
    const c = client([{ k: 0, n: 2 }]);
    await ownedOrThrow(4, { machine_ids: [5, 6, 6] }, c);
    expect(c.query.mock.calls[0][1]).toEqual([4, [5, 6]]);
    await expect(ownedOrThrow(4, { machine_ids: [5, 6, 8] }, client([{ k: 0, n: 2 }])))
      .rejects.toMatchObject({ status: 404 });
  });

  test('nothing named, nothing asked; no company, refused; not a number, 400', async () => {
    const c = client([]);
    await ownedOrThrow(4, { machine_id: null, shift_id: '' }, c);
    expect(c.query).not.toHaveBeenCalled();
    await expect(ownedOrThrow(null, { machine_id: 7 }, c)).rejects.toMatchObject({ status: 403 });
    await expect(ownedOrThrow(4, { machine_id: '7 OR 1=1' }, c)).rejects.toMatchObject({ status: 400 });
  });

  test('the built-in downtime reasons (no company) are everyone\'s', async () => {
    const c = client([{ k: 0, n: 1 }]);
    await ownedOrThrow(4, { downtime_reason_id: 2 }, c);
    expect(c.query.mock.calls[0][0]).toMatch(/\(company_id = \$1 OR company_id IS NULL\)/);
  });
});

describe('reads refuse another company\'s machine', () => {
  test('quality dashboard', async () => {
    const { getQualityDashboardService } = require('../../src/quality/quality.service');
    mockDb.denyOwnership();
    await expect(getQualityDashboardService({ company_id: 4, machine_id: 200, shift_id: 30, date: '2026-10-06' }))
      .rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()).toHaveLength(0);
    expect(mockDb.ownershipChecks()[0].params).toEqual([4, [200], [30]]);
  });

  test('hourly chart and part timing', async () => {
    const svc = require('../../src/charts/charts.service');
    mockDb.denyOwnership();
    await expect(svc.getChartData({ companyId: 4, machineId: 200, shiftId: 30, date: '2026-10-06' }))
      .rejects.toMatchObject({ status: 404 });
    mockDb.denyOwnership();
    await expect(svc.getPartTiming({ companyId: 4, machineId: 200, shiftStartEpoch: 1700000000 }))
      .rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('part timing reads at most 48 hours, whatever window is asked for', async () => {
    const svc = require('../../src/charts/charts.service');
    const end = Math.floor(Date.now() / 1000);
    await svc.getPartTiming({ companyId: 4, machineId: 7, shiftStartEpoch: end - 90 * 86400, shiftEndEpoch: end });
    const [, start, stop] = mockDb.calls()[0].params;
    expect(stop - start).toBe(48 * 3600);
  });
});

describe('writes refuse another company\'s records', () => {
  test('quality entry', async () => {
    const { upsertQualityEntryService } = require('../../src/quality/quality.service');
    mockDb.denyOwnership();
    await expect(upsertQualityEntryService({ company_id: 4, machine_id: 200, shift_id: 30, date: '2026-10-06', reject_qty: 7, rework_qty: 0 }))
      .rejects.toMatchObject({ status: 404 });
    expect(writes()).toHaveLength(0);
  });

  test('component: create on another company\'s machine, update of another company\'s component', async () => {
    const svc = require('../../src/component/component.service');
    mockDb.denyOwnership();
    await expect(svc.create({ machine_id: 200, part_name: 'X', part_number: 'P', cycle_time: '00:01:00', target: 9 }, null, 4))
      .rejects.toMatchObject({ status: 404 });
    expect(writes()).toHaveLength(0);

    mockDb.queueResponse({ rows: [], rowCount: 0 });      // UPDATE components … AND company_id: no row
    await expect(svc.update(55, { target: 9, part_name: 'X' }, null, 4)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls().filter(c => /machine_current_job/.test(c.text))).toHaveLength(0);
  });

  test('operator: create with another company\'s machines, update of another company\'s operator', async () => {
    const svc = require('../../src/operators/operator.service');
    mockDb.denyOwnership();
    await expect(svc.create({ operator_code: 'OP', operator_name: 'Op', shift_id: 30, machine_ids: [200] }, null, 4))
      .rejects.toMatchObject({ status: 404 });
    mockDb.denyOwnership();
    await expect(svc.update(77, { machine_ids: [7] }, null, 4)).rejects.toMatchObject({ status: 404 });
    expect(writes()).toHaveLength(0);
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.ownershipChecks()[1].params).toEqual([4, [77], [7]]);
  });

  test('operator list sorts by named columns only', async () => {
    const svc = require('../../src/operators/operator.service');
    mockDb.queueResponse({ rows: [{ total: '0' }] }, { rows: [] });
    await svc.list(null, { sortBy: 'o.operator_name; SELECT 1', order: 'asc' }, 4);
    expect(mockDb.calls()[1].text).toMatch(/ORDER BY o\.created_at ASC/);
    resetDb();
    mockDb.queueResponse({ rows: [{ total: '0' }] }, { rows: [] });
    await svc.list(null, { sortBy: 'operator_name' }, 4);
    expect(mockDb.calls()[1].text).toMatch(/ORDER BY o\.operator_name DESC/);
  });

  test('assignments: refused before the old assignment is ended; done in one transaction', async () => {
    const svc = require('../../src/assignments/assignment.service');
    mockDb.denyOwnership();
    await expect(svc.assignOperatorMachine({ operator_id: 77, machine_id: 200 }, 4)).rejects.toMatchObject({ status: 404 });
    expect(writes()).toHaveLength(0);

    mockDb.queueResponse({ rows: [] }, { rows: [] }, { rows: [{ id: 1 }] }, { rows: [] });
    await svc.assignOperatorShift({ operator_id: 7, shift_id: 3 }, 4);
    expect(mockDb.calls().map(c => c.text.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
  });

  test('ticket, maintenance schedule and log, downtime event', async () => {
    const tickets = require('../../src/tickets/ticket.service');
    const maint = require('../../src/maintenance/maintenance.service');
    const downtime = require('../../src/downtime/downtime.service');
    for (const run of [
      () => tickets.createTicket({ company_id: 4, machine_id: 200, title: 'T', created_by: 1 }),
      () => tickets.assignTicket(5, 4, { assigned_to: 900, changed_by: 1 }),
      () => maint.createSchedule({ company_id: 4, machine_id: 200, title: 'S', scheduled_at: '2026-10-08', created_by: 1 }),
      () => maint.updateSchedule(5, 4, { title: 'S', assigned_to: 900 }),
      () => maint.createLog({ company_id: 4, machine_id: 200, title: 'L', started_at: '2026-10-06', logged_by: 1 }),
      () => downtime.logEvent({ company_id: 4, machine_id: 200, shift_id: 30, entered_by: 1 }),
    ]) {
      mockDb.denyOwnership();
      await expect(run()).rejects.toMatchObject({ status: 404 });
    }
    expect(writes()).toHaveLength(0);
    expect(mockDb.connect).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  const routeOf = (router, method, path) => router.stack.find(l => l.route?.path === path && l.route.methods[method]);

  test('the debug route that wrote any machine\'s live state is gone', () => {
    expect(routeOf(require('../../src/master/master.routes'), 'post', '/test-multi')).toBeUndefined();
  });

  test('a company admin may save thresholds and periodic schedules on the company\'s grant', async () => {
    const router = require('../../src/dashboard/dashboard.routes');
    for (const path of ['/preventive/thresholds', '/periodic/schedules']) {
      const guard = routeOf(router, 'post', path).route.stack.find(s => s.handle.requiredPermission).handle;
      expect(guard.requiredPermission).toBe('page:maintenance:edit');
      mockDb.queueResponse({ rows: [{ permission_key: 'page:maintenance:edit' }] });   // the company's grants
      const next = jest.fn();
      const res = { status: jest.fn(() => res), json: jest.fn() };
      await guard({ user: { id: 1, company_id: 4, roles: ['COMPANY_ADMIN'], permissions: [] } }, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    }
  });
});
