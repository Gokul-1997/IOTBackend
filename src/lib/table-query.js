/*
 * A table's header sort and column filters, from the query string — the
 * MEXA table (29 Oct 2026, the user: "header filter and sorting on all
 * pages"; frontend shared/table/table-state.ts):
 *
 *   ?sort=machine&dir=desc          one column, either way
 *   ?f_status=OPEN,IN_PROGRESS      the rows whose column is one of these
 *                                   (__blank__: the rows with no value)
 *   ?q_title=spindle                the rows whose column contains this text
 *
 * Only the columns an endpoint lists are read, and the SQL for each comes
 * from that list, never from the request; every value is a bound parameter.
 *
 *   const t = tableQuery(req.query, {
 *     sort:   { machine: dir => machineOrder('m.machine_serial_no', dir), started: 'e.started_at' },
 *     filter: { status: 't.status', category: 'r.category' },
 *     search: { title: 't.title' }
 *   }, params);                         // the values are pushed onto params
 *   conditions.push(...t.where);
 *   ORDER BY ${t.orderBy ? `${t.orderBy}, ` : ''}e.started_at DESC, e.id DESC
 *
 * A sort's SQL is a column (sorted with NULLS LAST, so rows with no value
 * stay at the end either way) or a function of the direction for anything
 * else (machine names in their natural order).
 */
const BLANK = '__blank__';
const MAX_VALUES = 50;
const MAX_TEXT = 100;

const bad = message => ({ status: 400, message });

function tableQuery(query = {}, spec = {}, params = []) {
  const where = [];

  for (const [key, expr] of Object.entries(spec.filter || {})) {
    const raw = query[`f_${key}`];
    if (raw === undefined || raw === null || raw === '') continue;
    const values = [...new Set((Array.isArray(raw) ? raw.join(',') : String(raw)).split(',').map(v => v.trim()).filter(Boolean))];
    if (!values.length) continue;
    if (values.length > MAX_VALUES) throw bad(`Too many values to filter ${key} by`);
    if (values.some(v => v.length > MAX_TEXT)) throw bad(`A ${key} filter value is too long`);
    const listed = values.filter(v => v !== BLANK);
    const parts = [];
    if (listed.length) {
      params.push(listed);
      parts.push(`(${expr})::text = ANY($${params.length}::text[])`);
    }
    if (values.includes(BLANK)) parts.push(`NULLIF(btrim((${expr})::text), '') IS NULL`);
    where.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]);
  }

  for (const [key, expr] of Object.entries(spec.search || {})) {
    const raw = query[`q_${key}`];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) continue;
    if (text.length > MAX_TEXT) throw bad(`The ${key} search is too long`);
    // % and _ are the text's own characters, not wildcards
    params.push(`%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`);
    where.push(`(${expr})::text ILIKE $${params.length}`);
  }

  let orderBy = null;
  let sort = null;
  const key = typeof query.sort === 'string' ? query.sort : '';
  const def = key && spec.sort && Object.prototype.hasOwnProperty.call(spec.sort, key) ? spec.sort[key] : null;
  if (def) {
    const dir = String(query.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    orderBy = typeof def === 'function' ? def(dir) : `${def} ${dir} NULLS LAST`;
    sort = { key, dir: dir.toLowerCase() };
  }

  return { where, orderBy, sort };
}

/** The values a list filter asked for, checked as tableQuery checks them. */
function listValues(raw, key) {
  if (raw === undefined || raw === null || raw === '') return null;
  const values = [...new Set((Array.isArray(raw) ? raw.join(',') : String(raw)).split(',').map(v => v.trim()).filter(Boolean))];
  if (!values.length) return null;
  if (values.length > MAX_VALUES) throw bad(`Too many values to filter ${key} by`);
  if (values.some(v => v.length > MAX_TEXT)) throw bad(`A ${key} filter value is too long`);
  return values;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const isEmpty = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const keyOf = v => isEmpty(v) ? BLANK : typeof v === 'boolean' ? String(v) : String(v).trim();

/**
 * The same header for a list built in JavaScript (Energy's machines, the
 * Operator Dashboard): the same parameters, read through functions of the row.
 *
 *   const t = tableRows(rows, req.query, {
 *     sort:   { machine: r => r.machine_serial_no, energy: r => r.kwh },
 *     filter: { status: r => (r.is_overloaded ? 'overload' : 'normal') },
 *     search: { machine: r => r.machine_serial_no }
 *   });                                  // → { rows, sort }  (rows unsorted when no sort was asked)
 *
 * Numbers sort as numbers, text the way people read it ("VMC - 2" before
 * "VMC - 10"), and rows with no value stay last either way.
 */
function tableRows(rows, query = {}, spec = {}) {
  let out = rows;
  for (const [key, read] of Object.entries(spec.filter || {})) {
    const values = listValues(query[`f_${key}`], key);
    if (values) out = out.filter(r => values.includes(keyOf(read(r))));
  }
  for (const [key, read] of Object.entries(spec.search || {})) {
    const raw = query[`q_${key}`];
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!text) continue;
    if (text.length > MAX_TEXT) throw bad(`The ${key} search is too long`);
    out = out.filter(r => String(read(r) ?? '').toLowerCase().includes(text));
  }
  const key = typeof query.sort === 'string' ? query.sort : '';
  const read = key && spec.sort && Object.prototype.hasOwnProperty.call(spec.sort, key) ? spec.sort[key] : null;
  if (!read) return { rows: out, sort: null };
  const dir = String(query.dir || '').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const sign = dir === 'asc' ? 1 : -1;
  const keyed = out.map(r => ({ r, v: read(r) }));
  keyed.sort((a, b) => {
    const ea = isEmpty(a.v) || (typeof a.v === 'number' && !Number.isFinite(a.v));
    const eb = isEmpty(b.v) || (typeof b.v === 'number' && !Number.isFinite(b.v));
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    const d = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v
      : typeof a.v === 'boolean' || typeof b.v === 'boolean' ? Number(a.v) - Number(b.v)
      : collator.compare(String(a.v), String(b.v));
    return d * sign;
  });
  return { rows: keyed.map(x => x.r), sort: { key, dir } };
}

module.exports = { tableQuery, tableRows, BLANK };
