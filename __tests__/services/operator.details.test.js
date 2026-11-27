jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const service = require('../../src/operators/operator.service');
const { normalizeOptionalDetails } = require('../../src/helpers/validators/operator.validator');
const base = { operator_code: 'OP-1', operator_name: 'Operator', shift_id: 10 };

beforeEach(resetDb);

test('operator creation accepts omitted optional details and stores NULL', async () => {
  mockDb.queueResponse({}, { rows: [{ id: 7 }] });
  await service.create(base, null, 4);
  const insert = mockDb.calls().find(call => /INSERT INTO operators\s/.test(call.text));
  expect(insert.params.slice(-2)).toEqual([null, null]);
  expect(mockDb.calls().at(-1).text).toBe('COMMIT');
});

test('phone keeps its country code and DOB is saved as a calendar date', async () => {
  mockDb.queueResponse({}, { rows: [{ id: 7 }] });
  await service.create({ ...base, phone_number: ' +91 98765 43210 ', date_of_birth: '1995-02-28' }, null, 4);
  expect(mockDb.calls().find(call => /INSERT INTO operators\s/.test(call.text)).params.slice(-2))
    .toEqual(['+91 98765 43210', '1995-02-28']);
});

test('editing can clear either optional field without changing assignments', async () => {
  await service.update(7, { phone_number: ' ', date_of_birth: '' }, null, 4);
  const update = mockDb.calls().find(call => /UPDATE operators/.test(call.text));
  expect(update.params).toEqual([null, null, 7, 4]);
  expect(mockDb.calls().some(call => /operator_(shift|machine)_assignments/.test(call.text))).toBe(false);
});

test('an unrelated edit does not erase saved phone or birth date', async () => {
  await service.update(7, { operator_name: 'Updated' }, null, 4);
  const update = mockDb.calls().find(call => /UPDATE operators/.test(call.text));
  expect(update.text).not.toMatch(/phone_number|date_of_birth/);
  expect(update.params).toEqual(['Updated', 7, 4]);
});

test('edit data returns DOB without converting through a timezone', async () => {
  mockDb.queueResponse({ rows: [{ id: 7, phone_number: '+91 98765 43210', date_of_birth: '1995-02-28' }], rowCount: 1 }, { rows: [] }, { rows: [] });
  const result = await service.getById(7, null, 4);
  expect(result.data.date_of_birth).toBe('1995-02-28');
  expect(mockDb.calls()[0].text).toContain('date_of_birth::text AS date_of_birth');
  expect(mockDb.calls()[0].params).toEqual([7, 4]);
});

test.each([
  { phone_number: 9876543210 }, { phone_number: 'not a phone' },
  { date_of_birth: '1995-02-30' }, { date_of_birth: '31/01/1995' },
  { date_of_birth: '0000-01-01' }, { date_of_birth: '2999-01-01' }, { date_of_birth: true }
])('invalid details are rejected before a DB write: %j', async details => {
  await expect(service.create({ ...base, ...details }, null, 4)).rejects.toMatchObject({ status: 400 });
  expect(mockDb.connect).not.toHaveBeenCalled();
});

test('blank details are optional for API clients, and a leap day is accepted', () => {
  expect(normalizeOptionalDetails({ phone_number: '', date_of_birth: null })).toEqual({ phone_number: null, date_of_birth: null });
  expect(normalizeOptionalDetails({ date_of_birth: '2000-02-29' }).date_of_birth).toBe('2000-02-29');
});
