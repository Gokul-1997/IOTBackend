const db = require('../db');

exports.assignOperatorMachine = async (data, company_id) => {
  // Deactivate existing assignments for this operator (operators are company-scoped)
  await db.query(
    `UPDATE operator_machine_assignments
     SET is_active=FALSE
     WHERE operator_id=$1`,
    [data.operator_id]
  );

  const { rows } = await db.query(
    `INSERT INTO operator_machine_assignments
     (company_id, operator_id, machine_id, assigned_from)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [company_id, data.operator_id, data.machine_id, data.assigned_from]
  );
  return rows[0];
};

exports.assignOperatorShift = async (data, company_id) => {
  // Deactivate existing assignments for this operator (operators are company-scoped)
  await db.query(
    `UPDATE operator_shift_assignments
     SET is_active=FALSE
     WHERE operator_id=$1`,
    [data.operator_id]
  );

  const { rows } = await db.query(
    `INSERT INTO operator_shift_assignments
     (company_id, operator_id, shift_id, effective_from)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [company_id, data.operator_id, data.shift_id, data.effective_from]
  );
  return rows[0];
};
