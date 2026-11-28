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
  const part = { part_name: 'PartX', part_number: 'PN-1', operation_number: 'OP-1', cycle_time: '00:01:00', target: 50, multiplication_factor: 1 };
  const isInsert = call => /^\s*INSERT/.test(call.text);

  test('creates an occurrence with a new snapshot while closing the old occurrence unchanged', async () => {
    const newComp = { id: 99, machine_id: 7, target: 50, part_name: 'PartX', cycle_time_seconds: '60' };
    mockDb.queueResponse(
      response(), response([machine]), response(), response([newComp]), response([{ machine_id: 7 }]), response(), response()
    );

    const out = await svc.create({ machine_id: 7, ...part }, null, 4);

    expect(out.status).toBe('success');
    expect(out.data).toEqual(newComp);                       // one machine_id in, one component out, as before

    const calls = mockDb.calls();
    expect(calls[1].text).toMatch(/ORDER BY id FOR UPDATE/);
    expect(calls[1].params).toEqual([[7], 4, null]);
    expect(calls[2].text).toMatch(/EXISTS \(SELECT 1 FROM components c/);
    expect(calls[3].params).toEqual([4, 'PartX', 'PN-1', 'OP-1', '00:01:00', 50, 1, 8, 7]);
    expect(calls[4].text).toMatch(/SET is_active = FALSE, ended_at = NOW/);
    expect(calls[4].text).not.toMatch(/SET component_id|SET part_name/);
    expect(calls[4].params).toEqual([[7], 4]);
    expect(calls[5].text).toMatch(/INSERT INTO machine_current_job[\s\S]*SELECT c\.plant_id, c\.company_id, c\.machine_id, c\.id, c\.part_name, c\.target, NOW\(\), EXTRACT\(EPOCH FROM c\.cycle_time\)/);
    expect(calls[5].params).toEqual([[99], 4]);
    expect(calls.at(-1).text).toBe('COMMIT');
  });

  // 28 Nov 2026, the user: "in component entry I need to select multiple machines"
  test('many machines: each locked in id order, one component each in one statement, a list back', async () => {
    const made = [{ id: 31, machine_id: 7 }, { id: 32, machine_id: 9 }];
    mockDb.queueResponse(response(), response([machine, { id: 9, plant_id: 3 }]), response(), response(made), response(), response());

    const out = await svc.create({ machine_ids: [9, '7', 9], ...part, part_name: '  PartX ', part_number: ' PN-1' }, null, 4);

    expect(out).toEqual({ status: 'success', data: made });
    const calls = mockDb.calls();
    expect(calls[1].params).toEqual([[7, 9], 4, null]);      // once each, in id order
    expect(calls[2].params).toEqual([4, [7, 9], 'PartX', 'PN-1', 'OP-1']);
    expect(calls[3].text).toMatch(/VALUES \(\$8, \$1, \$9, \$2, \$3, \$4, \$5, \$6, \$7\), \(\$10, \$1, \$11, \$2, \$3, \$4, \$5, \$6, \$7\)/);
    expect(calls[3].params).toEqual([4, 'PartX', 'PN-1', 'OP-1', '00:01:00', 50, 1, 8, 7, 3, 9]);
    expect(calls[4].params).toEqual([[7, 9], 4]);
    expect(calls.filter(c => /INSERT INTO machine_current_job/.test(c.text))).toHaveLength(0);   // neither was running a job
    expect(calls.at(-1).text).toBe('COMMIT');
  });

  test('only the machines that were running a job move on to their new component', async () => {
    const made = [{ id: 31, machine_id: 7 }, { id: 32, machine_id: 9 }];
    mockDb.queueResponse(response(), response([machine, { id: 9, plant_id: 3 }]), response(), response(made), response([{ machine_id: 9 }]), response(), response());
    await svc.create({ machine_ids: [7, 9], ...part }, null, 4);
    const next = mockDb.calls().find(c => /INSERT INTO machine_current_job/.test(c.text));
    expect(next.params).toEqual([[32], 4]);
  });

  test('the same part already on some of the machines: a 409 naming them, nothing written', async () => {
    mockDb.queueResponse(response(), response([machine, { id: 9, plant_id: 3 }]),
      response([{ machine_serial_no: 'VMC - 2 - F' }, { machine_serial_no: 'VMC - 10 - M' }]));
    await expect(svc.create({ machine_ids: [7, 9], ...part }, null, 4)).rejects.toEqual({
      status: 409, code: 'COMPONENT_EXISTS',
      message: 'VMC - 2 - F and VMC - 10 - M already have PartX (PN-1 · OP-1) — edit theirs, or leave those machines out.'
    });
    expect(mockDb.calls().filter(isInsert)).toHaveLength(0);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
    // name, number and operation compared without case or surrounding spaces
    expect(mockDb.calls()[2].text).toMatch(/lower\(btrim\(COALESCE\(c\.part_number, ''\)\)\) = lower\(btrim\(COALESCE\(\$4::text, ''\)\)\)/);
  });

  test('one machine that already has it: the message is about that one', async () => {
    mockDb.queueResponse(response(), response([machine]), response([{ machine_serial_no: 'HMC - 7 - F' }]));
    await expect(svc.create({ machine_id: 7, ...part, operation_number: '' }, null, 4)).rejects.toMatchObject({
      status: 409, message: 'HMC - 7 - F already has PartX (PN-1) — edit that one, or leave that machine out.'
    });
  });

  test('a machine outside the plant is refused before a component is inserted', async () => {
    mockDb.queueResponse(response(), response());
    await expect(svc.create({ machine_id: 7, ...part }, 99, 4)).rejects.toEqual({ status: 404, message: 'Machine not found' });
    expect(mockDb.calls()[1].params).toEqual([[7], 4, 99]);
    expect(mockDb.calls().some(isInsert)).toBe(false);
    expect(mockDb.calls().at(-1).text).toBe('ROLLBACK');
  });

  test('a chosen machine switched off or gone meanwhile: all refused, the count said', async () => {
    mockDb.queueResponse(response(), response([machine]));
    await expect(svc.create({ machine_ids: [7, 9, 11], ...part }, null, 4)).rejects.toEqual({
      status: 404, message: '2 of the chosen machines are no longer available. Reload the page and choose again.'
    });
    expect(mockDb.calls().some(isInsert)).toBe(false);
  });

  test.each([
    [{ machine_ids: 'abc' }, 'Machines must be a list of machines'],
    [{ machine_ids: [] }, 'Choose at least one machine'],
    [{ machine_ids: [null, ''] }, 'Choose at least one machine'],
    [{}, 'Choose at least one machine'],
    [{ machine_ids: [0] }, 'Machine id is not valid'],
    [{ machine_ids: [7, -1] }, 'Machine id is not valid'],
    [{ machine_ids: [1.5] }, 'Machine id is not valid'],
    [{ machine_ids: ['7x'] }, 'Machine id is not valid'],
    [{ machine_ids: [true] }, 'Machine id is not valid'],
    [{ machine_ids: [2147483648] }, 'Machine id is not valid'],
    [{ machine_ids: Array.from({ length: 501 }, (_, i) => i + 1) }, 'Choose at most 500 machines at a time'],
    [{ machine_id: 7, part_name: '   ' }, 'Part name is required'],
    [{ machine_id: 7, part_number: ' ' }, 'Part number is required']
  ])('%j is a 400 before anything is read or written', async (input, message) => {
    await expect(svc.create({ ...part, ...input }, null, 4)).rejects.toEqual({ status: 400, message });
    expect(mockDb.calls()).toHaveLength(0);
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
