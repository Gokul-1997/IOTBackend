/*
 * Unit tests for component.service:
 *  - create() segments an active job instead of rewriting old production
 *  - list() applies search/machine filters and pagination
 *  - update() captures a new cycle snapshot only when production fields change
 *  - remove() deletes scoped to company
 */

jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/component/component.service');
const response = (rows = []) => ({ rows, rowCount: rows.length });
const machine = { id: 7, plant_id: 8 };

beforeEach(() => resetDb());

describe('component.service.create', () => {
  test('creates an occurrence with a new snapshot while closing the old occurrence unchanged', async () => {
    const newComp = { id: 99, target: 50, part_name: 'PartX', cycle_time_seconds: '60' };
    mockDb.queueResponse(
      response(), response([machine]), response([newComp]), response([{ id: 10 }]), response([{ id: 11 }]), response()
    );

    const out = await svc.create(
      { machine_id: 7, part_name: 'PartX', part_number: 'PN-1',
        operation_number: 'OP-1', cycle_time: '00:01:00', target: 50,
        multiplication_factor: 1 },
      null, 4
    );

    expect(out.status).toBe('success');
    expect(out.data).toEqual(newComp);

    const calls = mockDb.calls();
    expect(calls[1].text).toMatch(/FOR UPDATE/);
    expect(calls[3].text).toMatch(/SET is_active = FALSE, ended_at = NOW/);
    expect(calls[3].text).not.toMatch(/SET component_id|SET part_name/);
    expect(calls[3].params).toEqual([7, 4, null]);
    expect(calls[4].params).toEqual([8, 4, 7, 99, 'PartX', 50, '60']);
    expect(calls.at(-1).text).toBe('COMMIT');
  });
  test('a machine outside the plant is refused before a component is inserted', async () => {
    mockDb.queueResponse(response(), response());
    await expect(svc.create({ machine_id: 7 }, 99, 4)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()[1].params).toEqual([7, 4, 99]);
    expect(mockDb.calls().some(call => /^\s*INSERT/.test(call.text))).toBe(false);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
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
  test('plant scope covers data and count even if the requested machine is in another plant', async () => {
    mockDb.queueResponse(response([{ total: 0 }]), response());
    await svc.list(8, { machine_id: '99', limit: 100000 }, 4);
    for (const call of mockDb.calls()) {
      expect(call.text).toMatch(/m.company_id = \$1/);
      expect(call.text).toMatch(/m.plant_id = \$2/);
      expect(call.params).toEqual([4, 8, '99']);
    }
    expect(mockDb.calls()[1].text).toMatch(/LIMIT 100 OFFSET 0/);
  });
});

describe('component.service.update', () => {
  test('an actual target or cycle edit starts a separate occurrence with a new snapshot', async () => {
    const updated = { id: 5, part_name: 'NewName', target: 80, cycle_time_seconds: '60' };
    mockDb.queueResponse(
      response(), response([{ id: 5, machine_id: 7 }]), response([machine]),
      response([{ id: 5, part_name: 'OldName', target: 50, cycle_time_seconds: '120' }]), response([updated]), response([{ id: 10 }]), response([{ id: 11 }]), response()
    );

    await svc.update(5, {
      part_name: 'NewName', part_number: 'PN', operation_number: 'OP',
      cycle_time: '00:01:00', target: 80, multiplication_factor: 2
    }, null, 4);

    const calls = mockDb.calls();
    expect(calls[2].text).toMatch(/machines[\s\S]*FOR UPDATE/);
    expect(calls[3].text).toMatch(/components[\s\S]*FOR UPDATE/);
    expect(calls[4].text).toMatch(/UPDATE\s+components/);
    expect(calls[5].params).toEqual([7, 4, 5]);
    expect(calls[6].params).toEqual([8, 4, 7, 5, 'NewName', 80, '60']);
    expect(calls.at(-1).text).toBe('COMMIT');
  });
  test('saving unchanged production fields keeps the same active occurrence', async () => {
    const component = { id: 5, part_name: 'Part', target: 50, cycle_time_seconds: '60' };
    mockDb.queueResponse(response(), response([{ id: 5, machine_id: 7 }]), response([machine]), response([component]), response([component]), response());
    await svc.update(5, { part_name: 'Part', target: 50, cycle_time: '00:01:00', operation_number: '20' }, 8, 4);
    expect(mockDb.calls().some(call => /UPDATE machine_current_job|INSERT INTO machine_current_job/.test(call.text))).toBe(false);
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });
  test('a failed replacement rolls back the catalogue edit and closing of the old job together', async () => {
    const before = { id: 5, part_name: 'Part', target: 50, cycle_time_seconds: '60' };
    mockDb.queueResponse(response(), response([{ id: 5, machine_id: 7 }]), response([machine]), response([before]), response([{ ...before, target: 80 }]), response([{ id: 10 }]));
    mockDb.queueError(new Error('snapshot write failed'));
    await expect(svc.update(5, { target: 80 }, 8, 4)).rejects.toThrow('snapshot write failed');
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });
});

describe('component.service.remove', () => {
  test('deletes scoped by company_id', async () => {
    mockDb.queueResponse({ rows: [], rowCount: 1 });
    const out = await svc.remove(5, null, 4);
    expect(out.status).toBe('success');
    expect(mockDb.calls()[0].text).toMatch(/DELETE FROM components/);
    expect(mockDb.calls()[0].params).toEqual([5, 4, null]);
  });
  test('a component outside the plant cannot be deleted', async () => {
    mockDb.queueResponse(response());
    await expect(svc.remove(5, 8, 4)).rejects.toMatchObject({ status: 404 });
    expect(mockDb.calls()[0].params).toEqual([5, 4, 8]);
    expect(mockDb.calls()[0].text).toMatch(/m.plant_id=\$3/);
  });
});
