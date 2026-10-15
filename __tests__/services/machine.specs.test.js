/*
 * A machine's specification fields as the form sends them. On 15 Oct 2026 a
 * 3-axis machine could not be created: the empty 4th-axis box arrived as ""
 * and Postgres refused it for an integer column — a 500 the user could not
 * act on. Empty is "not set"; a bad number is a 400 naming the field.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const { cleanSpecs, INT_MAX } = require('../../src/machines/machine-specs');
const machines = require('../../src/machines/machine.service');

const response = (rows = []) => ({ rows, rowCount: rows.length });
beforeEach(() => resetDb());

describe('cleanSpecs', () => {
  test.each(['', '   ', null])('%p in any field means "not set"', blank => {
    const all = ['x_axis', 'y_axis', 'z_axis', 'fourth_axis', 'fifth_axis', 'spindle_rpm',
      'model', 'controller', 'mmc_no', 'atc_tool_capacity', 'twin_spindle', 'twin_table'];
    const specs = cleanSpecs(Object.fromEntries(all.map(key => [key, blank])));
    expect(specs).toEqual(Object.fromEntries(all.map(key => [key, null])));
  });

  test('numbers are stored as whole numbers, text trimmed, switches as booleans', () => {
    expect(cleanSpecs({ x_axis: 1050, fourth_axis: ' 360 ', spindle_rpm: '12000', model: ' Mazak VCN-530C ',
      atc_tool_capacity: '20+1', twin_spindle: true, twin_table: 'false' })).toEqual({
      x_axis: 1050, fourth_axis: 360, spindle_rpm: 12000, model: 'Mazak VCN-530C',
      atc_tool_capacity: '20+1', twin_spindle: true, twin_table: false
    });
    expect(cleanSpecs({ fifth_axis: 0, y_axis: INT_MAX })).toEqual({ fifth_axis: 0, y_axis: INT_MAX });
  });

  test('fields the request does not carry stay out, so an edit changes only what it sends', () => {
    expect(cleanSpecs({ model: 'HM400' })).toEqual({ model: 'HM400' });
    expect(cleanSpecs({})).toEqual({});
  });

  test.each([
    ['fourth_axis', '1050.5', '4th axis'], ['x_axis', -1, 'X axis'], ['spindle_rpm', '12k', 'Spindle speed'],
    ['z_axis', INT_MAX + 1, 'Z axis'], ['y_axis', 1e21, 'Y axis'], ['fifth_axis', true, '5th axis'],
    ['x_axis', [5], 'X axis']
  ])('%s = %p is a 400 naming the field', (key, value, label) => {
    expect(() => cleanSpecs({ [key]: value })).toThrow(expect.objectContaining({
      status: 400, code: 'BAD_MACHINE_SPEC', message: `${label} must be a whole number, 0 or more.`
    }));
  });

  test('an object is never stored as "[object Object]", and a switch is on or off', () => {
    expect(() => cleanSpecs({ model: { name: 'x' } })).toThrow(expect.objectContaining({ status: 400, message: 'Model must be text.' }));
    expect(() => cleanSpecs({ twin_table: 'maybe' })).toThrow(expect.objectContaining({ status: 400, message: 'Twin table must be on or off.' }));
  });
});

describe('the machine API with the form as it is sent', () => {
  const user = { company_id: 4, plant_id: null };
  // A 3-axis VMC: every box the user did not touch is "".
  const form = {
    machine_serial_no: 'VMC-12', model: '', image_url: '', controller: '', mmc_no: '', spindle_rpm: '',
    x_axis: 1050, y_axis: 530, z_axis: 510, fourth_axis: '', fifth_axis: '',
    twin_spindle: false, twin_table: false, atc_tool_capacity: '', plant_id: 5, line_id: 8, is_active: true, hour_rate: null
  };

  test('a machine with its 4th and 5th axis left blank is created with them not set', async () => {
    mockDb.queueResponse(response(), response([{ id: 4 }]), response([{ max_machines: null }]),
      response([{ id: 8, plant_id: 5 }]), response([{ id: 5 }]), response([{ id: 7, plant_id: 5 }]), response(), response());
    await machines.createMachine({ user, body: form });
    const insert = mockDb.calls().find(call => /INSERT INTO machines/.test(call.text));
    expect(insert.params.slice(0, 18)).toEqual([5, 4, 8, 'VMC-12', 1050, 530, 510, null, null,
      false, false, null, null, null, null, null, null, null]);
    expect(insert.params).not.toContain('');
    expect(mockDb.calls().at(-1).text).toBe('COMMIT');
  });

  test('a bad number is refused before anything is read or written', async () => {
    await expect(machines.createMachine({ user, body: { ...form, x_axis: 1050.5 } }))
      .rejects.toMatchObject({ status: 400, message: 'X axis must be a whole number, 0 or more.' });
    expect(mockDb.calls()).toHaveLength(0);
  });

  test('an edit that clears the 4th axis stores null', async () => {
    mockDb.queueResponse(response([{ id: 7 }]), response());
    await machines.updateMachine({ user, params: { id: '7' }, body: { fourth_axis: '', model: ' HM400 ' } });
    const update = mockDb.calls().find(call => /UPDATE machines/.test(call.text));
    expect(update.text).toMatch(/fourth_axis = \$1, model = \$2/);
    expect(update.params.slice(0, 2)).toEqual([null, 'HM400']);
  });
});
