const db = require('../db');
const { pagination } = require('../lib/pagination');
const valid = require('../lib/work-validation');
const { ownedOrThrow } = require('../lib/tenant');
const { addMachinePlantScope } = require('../lib/plant-scope');
const { tableQuery } = require('../lib/table-query');
const { machineOrder } = require('../lib/machine-order');

// One row per code per owner. The built-in codes (no company) are in the
// table twice — migration 007 ran twice, and its unique index treats every
// NULL company as different — so the oldest copy of each is the one shown.
exports.getReasons = async (company_id) => {
  const res = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (company_id, code) * FROM downtime_reasons
        WHERE (company_id = $1 OR company_id IS NULL) AND is_active = true
        ORDER BY company_id, code, id
     ) r
     ORDER BY category, name`,
    [company_id]
  );
  return res.rows;
};

/** A code the company already has: say so, instead of a server error. */
const takenCode = (e, code) => {
  if (e.code === '23505') return { status: 409, message: `Reason code ${String(code).toUpperCase()} already exists` };
  return e;
};

const CATEGORIES = new Set(['UNPLANNED', 'PLANNED', 'QUALITY', 'CHANGEOVER']);
function companyOf(value) {
  const company = Number(value);
  if (!Number.isInteger(company) || company <= 0 || company > 2147483647) {
    throw { status: 403, message: 'This account belongs to no company' };
  }
  return company;
}
function reasonId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    throw { status: 400, message: 'Reason id must be a positive integer' };
  }
  return id;
}
function reasonFields(input = {}) {
  const { code, name, category } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const field = (value, label, max) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw { status: 400, message: `${label} is required and must be text of at most ${max} characters` };
    }
    return value.trim();
  };
  const result = {
    code: field(typeof code === 'string' ? code.toUpperCase() : code, 'Code', 20),
    name: field(name, 'Name', 100),
    category: category === undefined || category === null || category === '' ? 'UNPLANNED'
      : typeof category === 'string' ? category.trim().toUpperCase() : ''
  };
  if (!CATEGORIES.has(result.category)) throw { status: 400, message: 'Category must be Unplanned, Planned, Quality or Changeover' };
  return result;
}

exports.createReason = async ({ company_id, code, name, category }) => {
  const company = companyOf(company_id);
  const fields = reasonFields({ code, name, category });
  const res = await db.query(
    `INSERT INTO downtime_reasons (company_id, code, name, category)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [company, fields.code, fields.name, fields.category]
  ).catch(e => { throw takenCode(e, fields.code); });
  return res.rows[0];
};

exports.updateReason = async (id, company_id, input) => {
  const company = companyOf(company_id);
  const reason = reasonId(id);
  const fields = reasonFields(input);
  const active = input?.is_active;
  if (active !== undefined && typeof active !== 'boolean') throw { status: 400, message: 'Active must be true or false' };
  const res = await db.query(
    `UPDATE downtime_reasons SET code=$1, name=$2, category=$3, is_active=$4
     WHERE id=$5 AND company_id=$6 AND is_active = TRUE RETURNING *`,
    [fields.code, fields.name, fields.category, active ?? true, reason, company]
  ).catch(e => { throw takenCode(e, fields.code); });
  if (!res.rowCount) throw { status: 404, message: 'Reason not found' };
  return res.rows[0];
};

/** Retain the reason row and its event links, so historical reports still name it. */
exports.deleteReason = async (id, company_id) => {
  const company = companyOf(company_id);
  const reason = reasonId(id);
  const res = await db.query(
    `UPDATE downtime_reasons SET is_active = FALSE
     WHERE id=$1 AND company_id=$2 AND is_active = TRUE RETURNING *`,
    [reason, company]
  );
  if (!res.rowCount) throw { status: 404, message: 'Reason not found' };
  return res.rows[0];
};

exports.logEvent = async ({ company_id, machine_id, shift_id, downtime_reason_id, started_at, ended_at, notes, entered_by, plant_id = null }) => {
  if (!machine_id) throw { status: 400, message: 'machine_id is required' };
  const { from, to } = valid.window(started_at || new Date(), ended_at, 'started_at', 'ended_at');
  await ownedOrThrow(company_id, { machine_id, shift_id, downtime_reason_id });
  const res = await db.query(
    `INSERT INTO downtime_events (company_id, machine_id, shift_id, downtime_reason_id, started_at, ended_at, notes, entered_by)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8
      WHERE ($4::integer IS NULL OR EXISTS (
        SELECT 1 FROM downtime_reasons WHERE id=$4 AND is_active = TRUE
          AND (company_id=$1 OR company_id IS NULL)
      ))
      ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines WHERE id=$2 AND company_id=$1 AND plant_id=$9)'} RETURNING *`,
    [company_id, machine_id, shift_id || null, downtime_reason_id || null,
     from, to, notes || null, entered_by, ...(plant_id == null ? [] : [plant_id])]
  );
  if (!res.rowCount) throw { status: 404, message: plant_id == null ? 'Active downtime reason not found' : 'Machine or active downtime reason not found in your plant' };
  return res.rows[0];
};

/* The Events table's header (lib/table-query.js, 29 Oct 2026): sort any
   column; filter machine, reason, category and who entered it. */
const EVENT_TABLE = {
  sort: { machine: dir => machineOrder('m.machine_serial_no', dir), reason: 'dr.name', category: 'dr.category',
          started: 'e.started_at', duration: 'e.duration_seconds', by: 'u.username' },
  filter: { machine: 'm.machine_serial_no', reason: 'dr.name', category: 'dr.category', by: 'u.username' },
  search: { machine: 'm.machine_serial_no', by: 'u.username' }
};

exports.getEvents = async (q) => {
  const { company_id, machine_id, from_date, to_date, page = 1, limit = 20, plant_id = null } = q;
  const conditions = [`e.company_id = $1`];
  const params = [company_id];
  let i = 2;

  if (machine_id) { conditions.push(`e.machine_id = $${i++}`); params.push(machine_id); }
  if (from_date)  { conditions.push(`e.started_at >= $${i++}`); params.push(from_date); }
  if (to_date)    { conditions.push(`e.started_at <= $${i++}`); params.push(to_date); }
  addMachinePlantScope(conditions, params, 'e', plant_id);
  const table = tableQuery(q, EVENT_TABLE, params);
  conditions.push(...table.where);
  i = params.length + 1;

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { pageNum, limitNum, offset } = pagination(page, limit);

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM downtime_events e JOIN machines m ON m.id = e.machine_id
               LEFT JOIN downtime_reasons dr ON dr.id = e.downtime_reason_id LEFT JOIN users u ON u.id = e.entered_by ${where}`, params),
    db.query(
      `SELECT e.*, m.machine_serial_no, dr.name as reason_name, dr.category,
              u.username as entered_by_name
       FROM downtime_events e
       JOIN machines m ON m.id = e.machine_id
       LEFT JOIN downtime_reasons dr ON dr.id = e.downtime_reason_id
       LEFT JOIN users u ON u.id = e.entered_by
       ${where}
       ORDER BY ${table.orderBy ? `${table.orderBy}, ` : ''}e.started_at DESC, e.id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limitNum, offset]
    )
  ]);

  return {
    data: dataRes.rows,
    pagination: { page: pageNum, limit: limitNum, total: parseInt(countRes.rows[0].count), totalPages: Math.ceil(parseInt(countRes.rows[0].count) / limitNum) }
  };
};

// The last 7 days unless the caller names dates. The defaults are SQL, not
// bind values: "NOW() - INTERVAL '7 days'" sent as a value is not a time, and
// every summary without dates (the Downtime page's Summary tab) was a 500.
exports.getDowntimeSummary = async ({ company_id, from_date, to_date, plant_id = null }) => {
  for (const [label, v] of [['from_date', from_date], ['to_date', to_date]]) {
    if (v && Number.isNaN(Date.parse(v))) throw { status: 400, message: `${label} is not a date` };
  }
  const res = await db.query(
    `SELECT dr.category, dr.name as reason_name, dr.code,
            COUNT(*) as event_count,
            SUM(e.duration_seconds) as total_seconds
     FROM downtime_events e
     LEFT JOIN downtime_reasons dr ON dr.id = e.downtime_reason_id
     WHERE e.company_id = $1
       ${plant_id == null ? '' : 'AND EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id=e.machine_id AND scoped_machine.company_id=$1 AND scoped_machine.plant_id=$4)'}
       AND e.started_at >= COALESCE($2::timestamptz, NOW() - INTERVAL '7 days')
       AND e.started_at <= COALESCE($3::timestamptz, NOW())
       AND e.ended_at IS NOT NULL
     GROUP BY dr.category, dr.name, dr.code
     ORDER BY total_seconds DESC`,
    [company_id, from_date || null, to_date || null, ...(plant_id == null ? [] : [plant_id])]
  );
  return res.rows;
};
