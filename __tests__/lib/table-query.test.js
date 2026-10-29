/*
 * lib/table-query: a table's header sort and filters, whitelisted and bound.
 */
const { tableQuery, tableRows, BLANK } = require('../../src/lib/table-query');

const SPEC = {
  sort: { started: 'e.started_at', machine: dir => `natural(m.name) ${dir}` },
  filter: { status: 't.status', category: 'r.category' },
  search: { title: 't.title' }
};

test('nothing asked: nothing added', () => {
  const params = [4];
  expect(tableQuery({}, SPEC, params)).toEqual({ where: [], orderBy: null, sort: null });
  expect(params).toEqual([4]);
});

test('a sort from the list, either way; NULLS LAST so empty cells stay at the end', () => {
  expect(tableQuery({ sort: 'started', dir: 'desc' }, SPEC, []).orderBy).toBe('e.started_at DESC NULLS LAST');
  expect(tableQuery({ sort: 'started', dir: 'asc' }, SPEC, []).orderBy).toBe('e.started_at ASC NULLS LAST');
  expect(tableQuery({ sort: 'started' }, SPEC, []).sort).toEqual({ key: 'started', dir: 'asc' });
  expect(tableQuery({ sort: 'machine', dir: 'desc' }, SPEC, []).orderBy).toBe('natural(m.name) DESC');
});

test.each([['password'], ['started; DROP TABLE x'], ['__proto__'], ['constructor'], [['started']]])(
  'a sort not on the list (%j) is ignored, never written into SQL', sort => {
    expect(tableQuery({ sort, dir: 'desc' }, SPEC, []).orderBy).toBeNull();
  });

test('a list filter: one bound array per column, numbered after the caller\'s own', () => {
  const params = [4, '2026-10-01'];
  const t = tableQuery({ f_status: 'OPEN,IN_PROGRESS,OPEN', f_category: 'PLANNED', f_nope: 'x' }, SPEC, params);
  expect(t.where).toEqual(['(t.status)::text = ANY($3::text[])', '(r.category)::text = ANY($4::text[])']);
  expect(params).toEqual([4, '2026-10-01', ['OPEN', 'IN_PROGRESS'], ['PLANNED']]);
});

test('(Blank) finds the rows with no value, alone or with others', () => {
  const params = [];
  expect(tableQuery({ f_status: BLANK }, SPEC, params).where).toEqual(["NULLIF(btrim((t.status)::text), '') IS NULL"]);
  expect(params).toEqual([]);
  const t = tableQuery({ f_status: `OPEN,${BLANK}` }, SPEC, params);
  expect(t.where).toEqual(["((t.status)::text = ANY($1::text[]) OR NULLIF(btrim((t.status)::text), '') IS NULL)"]);
  expect(params).toEqual([['OPEN']]);
});

test('a search: contains, any case, its % and _ taken as they are', () => {
  const params = [];
  const t = tableQuery({ q_title: '  50%_off ' }, SPEC, params);
  expect(t.where).toEqual(['(t.title)::text ILIKE $1']);
  expect(params).toEqual(['%50\\%\\_off%']);
  expect(tableQuery({ q_title: '   ' }, SPEC, []).where).toEqual([]);
});

test('too much is a 400, not a slow query', () => {
  expect(() => tableQuery({ f_status: Array.from({ length: 51 }, (_, i) => `v${i}`).join(',') }, SPEC, []))
    .toThrow(expect.objectContaining({ status: 400 }));
  expect(() => tableQuery({ q_title: 'x'.repeat(101) }, SPEC, [])).toThrow(expect.objectContaining({ status: 400 }));
});

describe('tableRows: the same header for a list built in JavaScript', () => {
  const ROWS = [
    { m: 'VMC - 10', kwh: 12, s: 'normal' }, { m: 'VMC - 2', kwh: null, s: 'overload' },
    { m: 'HMC - 1', kwh: 30, s: 'normal' }, { m: 'VMC - 1', kwh: 4, s: '' }
  ];
  const SPEC = { sort: { machine: r => r.m, energy: r => r.kwh }, filter: { status: r => r.s }, search: { machine: r => r.m } };
  const names = t => t.rows.map(r => r.m);

  test('text the way people read it; numbers as numbers; no value last either way', () => {
    expect(names(tableRows(ROWS, { sort: 'machine', dir: 'asc' }, SPEC))).toEqual(['HMC - 1', 'VMC - 1', 'VMC - 2', 'VMC - 10']);
    expect(names(tableRows(ROWS, { sort: 'energy', dir: 'desc' }, SPEC))).toEqual(['HMC - 1', 'VMC - 10', 'VMC - 1', 'VMC - 2']);
    expect(names(tableRows(ROWS, { sort: 'energy', dir: 'asc' }, SPEC))).toEqual(['VMC - 1', 'VMC - 10', 'HMC - 1', 'VMC - 2']);
  });
  test('filters and searches; an unknown sort leaves the order as it was', () => {
    expect(names(tableRows(ROWS, { f_status: `overload,${BLANK}` }, SPEC))).toEqual(['VMC - 2', 'VMC - 1']);
    expect(names(tableRows(ROWS, { q_machine: 'vmc - 1' }, SPEC))).toEqual(['VMC - 10', 'VMC - 1']);
    const t = tableRows(ROWS, { sort: '__proto__' }, SPEC);
    expect(t.sort).toBeNull();
    expect(names(t)).toEqual(ROWS.map(r => r.m));
  });
});
