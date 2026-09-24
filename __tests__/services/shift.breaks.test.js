/*
 * Break windows on a shift (migration 028) — saved as a whole list, so they
 * can be checked against each other: inside the shift, not overlapping,
 * named, and at most ten.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const svc = require('../../src/shifts/shift.service');

const day = { id: 5, start_time: '08:00:00', end_time: '20:00:00' };
const night = { id: 6, start_time: '20:00:00', end_time: '08:00:00' };

beforeEach(() => resetDb());

const save = (shift, breaks) => { mockDb.queueResponse({ rows: [shift] }); return svc.saveBreaks(shift.id, 4, breaks); };

test.each([
  [day, [{ break_name: '', start_time: '10:00', end_time: '10:15' }], 'Break 1 needs a name'],
  [day, [{ break_name: 'Tea', start_time: '10', end_time: '10:15' }], 'Tea: start and end must be times, like 11:00'],
  [day, [{ break_name: 'Tea', start_time: '10:00', end_time: '10:00' }], 'Tea: the end must be after the start'],
  [day, [{ break_name: 'Late', start_time: '19:45', end_time: '20:15' }], 'Late must fall inside the shift (08:00–20:00)'],
  [day, [{ break_name: 'Early', start_time: '07:30', end_time: '08:10' }], 'Early must fall inside the shift (08:00–20:00)'],
  [day, [{ break_name: 'Tea', start_time: '10:00', end_time: '10:30' },
         { break_name: 'Lunch', start_time: '10:15', end_time: '11:00' }], 'Lunch overlaps Tea'],
  [day, Array.from({ length: 11 }, (_, i) => ({ break_name: `B${i}`, start_time: `1${i % 10}:00`, end_time: `1${i % 10}:05` })),
        'A shift can have at most 10 breaks'],
  [day, 'nope', 'breaks must be a list']
])('refuses %#: %s', async (shift, breaks, message) => {
  await expect(save(shift, breaks)).rejects.toMatchObject({ status: 400, message });
  expect(mockDb.calls().some(c => /shift_breaks/.test(c.text))).toBe(false);   // nothing written
});

test('a night shift takes breaks either side of midnight', async () => {
  mockDb.queueResponse(
    { rows: [night] },                                  // ownShift
    { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },   // BEGIN, DELETE, 2×INSERT, COMMIT
    { rows: [night] },                                  // getBreaks → ownShift
    { rows: [{ id: 2, break_name: 'Tea', start_time: '02:00', end_time: '02:15' },
             { id: 1, break_name: 'Dinner', start_time: '23:30', end_time: '00:15' }] }
  );
  const out = await svc.saveBreaks(6, 4, [
    { break_name: 'Tea', start_time: '02:00', end_time: '02:15' },
    { break_name: 'Dinner', start_time: '23:30', end_time: '00:15' }
  ]);
  const inserts = mockDb.calls().filter(c => /INSERT INTO shift_breaks/.test(c.text)).map(c => c.params);
  // stored in shift order: dinner before midnight, tea after
  expect(inserts).toEqual([[4, 6, 'Dinner', '23:30', '00:15'], [4, 6, 'Tea', '02:00', '02:15']]);
  expect(out.map(b => [b.break_name, b.minutes])).toEqual([['Dinner', 45], ['Tea', 15]]);
});

test('replaces the list in one transaction, scoped to the company', async () => {
  mockDb.queueResponse({ rows: [day] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [day] }, { rows: [] });
  await svc.saveBreaks(5, 4, [{ break_name: ' Tea Break ', start_time: '11:00:00', end_time: '11:15' }]);
  const texts = mockDb.calls().map(c => c.text.trim().split(/\s+/).slice(0, 3).join(' '));
  expect(texts.slice(1, 5)).toEqual(['BEGIN', 'DELETE FROM shift_breaks', 'INSERT INTO shift_breaks', 'COMMIT']);
  expect(mockDb.calls()[2].params).toEqual([5, 4]);
  expect(mockDb.calls()[3].params).toEqual([4, 5, 'Tea Break', '11:00', '11:15']);
});

test('an empty list clears the breaks', async () => {
  mockDb.queueResponse({ rows: [day] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [day] }, { rows: [] });
  expect(await svc.saveBreaks(5, 4, [])).toEqual([]);
});

test('another company\'s shift is not found', async () => {
  mockDb.queueResponse({ rows: [] });
  await expect(svc.getBreaks(5, 99)).rejects.toMatchObject({ status: 404, message: 'Shift not found' });
  expect(mockDb.calls()[0].params).toEqual([5, 99]);
});

test('before migration 028: a clear 503, not a 500', async () => {
  mockDb.queueResponse({ rows: [day] });
  mockDb.queueError(Object.assign(new Error('relation "shift_breaks" does not exist'), { code: '42P01' }));
  await expect(svc.getBreaks(5, 4)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/database update 028/) });
});
