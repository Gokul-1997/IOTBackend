const db = require('../db');
const { ownedOrThrow } = require('../lib/tenant');

/* The operator, machine and shift come from the request and must all be this
   company's; the old assignment is ended and the new one written together,
   so a failed insert no longer leaves the operator with none. */
async function reassign(table, column, data, company_id, from) {
  await ownedOrThrow(company_id, { operator_id: data.operator_id, [column]: data[column] });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE ${table} SET is_active = FALSE WHERE operator_id = $1`, [data.operator_id]);
    const dateCol = table === 'operator_machine_assignments' ? 'assigned_from' : 'effective_from';
    const { rows } = await client.query(
      `INSERT INTO ${table} (company_id, operator_id, ${column}, ${dateCol})
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE)) RETURNING *`,
      [company_id, data.operator_id, data[column], from || null]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

exports.assignOperatorMachine = (data, company_id) =>
  reassign('operator_machine_assignments', 'machine_id', data, company_id, data.assigned_from);

exports.assignOperatorShift = (data, company_id) =>
  reassign('operator_shift_assignments', 'shift_id', data, company_id, data.effective_from);
