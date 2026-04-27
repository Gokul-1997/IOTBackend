/*
 * Unit tests for component.service:
 *  - create() inserts and cascades the new target into machine_current_job
 *  - list() applies search/machine filters and pagination
 *  - update() syncs target_qty + part_name back to active jobs
 *  - remove() deletes scoped to company
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/component/component.service');

beforeEach(() => resetDb());

describe('component.service.create', () => {
  test('inserts new component AND cascades target to active job', async () => {
    const newComp = { id: 99, target: 50, part_name: 'PartX' };
    mockDb.queueResponse(
      { rows: [newComp], rowCount: 1 },   // INSERT components
      { rows: [],        rowCount: 0 }     // UPDATE machine_current_job
    );

    const out = await svc.create(
      { machine_id: 7, part_name: 'PartX', part_number: 'PN-1',
        operation_number: 'OP-1', cycle_time: '00:01:00', target: 50,
        multiplication_factor: 1 },
      null, 4
    );

    expect(out.status).toBe('success');
    expect(out.data).toEqual(newComp);

    // assert second call was the cascade UPDATE on machine_current_job
    const calls = mockDb.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toMatch(/UPDATE\s+machine_current_job/);
    expect(calls[1].params).toEqual([99, 50, 'PartX', 7]);
  });
});

describe('component.service.list', () => {
  test('paginates with default page=1, limit=6', async () => {
    mockDb.queueResponse(
      { rows: [{ total: '12' }] },
      { rows: [{ id: 1 }, { id: 2 }] }
    );

    const res = await svc.list(null, {}, 4);
    expect(res.meta).toEqual({ page: 1, limit: 6, total: 12, totalPages: 2 });
    expect(res.data).toHaveLength(2);
  });

  test('applies machine_id filter', async () => {
    mockDb.queueResponse(
      { rows: [{ total: '0' }] },
      { rows: [] }
    );
    await svc.list(null, { machine_id: '7' }, 4);
    const calls = mockDb.calls();
    expect(calls[0].params).toEqual([4, '7']);   // company + machine
    expect(calls[0].text).toMatch(/c\.machine_id\s*=\s*\$2/);
  });

  test('applies search filter against part_name / part_number / serial', async () => {
    mockDb.queueResponse(
      { rows: [{ total: '0' }] },
      { rows: [] }
    );
    await svc.list(null, { search: 'foo' }, 4);
    expect(mockDb.calls()[0].text).toMatch(/ILIKE/);
    expect(mockDb.calls()[0].params).toEqual([4, '%foo%']);
  });
});

describe('component.service.update', () => {
  test('syncs target_qty + part_name to active jobs', async () => {
    mockDb.queueResponse(
      { rows: [{ id: 5 }], rowCount: 1 },
      { rows: [],          rowCount: 0 }
    );

    await svc.update(5, {
      part_name: 'NewName', part_number: 'PN', operation_number: 'OP',
      cycle_time: '00:01:00', target: 80, multiplication_factor: 2
    }, null, 4);

    const calls = mockDb.calls();
    expect(calls[0].text).toMatch(/UPDATE\s+components/);
    expect(calls[1].text).toMatch(/UPDATE\s+machine_current_job/);
    expect(calls[1].params).toEqual([80, 'NewName', 5]);
  });
});

describe('component.service.remove', () => {
  test('deletes scoped by company_id', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 });
    const out = await svc.remove(5, null, 4);
    expect(out.status).toBe('success');
    expect(mockDb.calls()[0].text).toMatch(/DELETE FROM components/);
    expect(mockDb.calls()[0].params).toEqual([5, 4]);
  });
});
