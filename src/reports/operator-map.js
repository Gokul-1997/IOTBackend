/*
 * Which operator a report row names: the machine's most recent active
 * assignment to an active operator, one per machine.
 *
 * Every report uses this one rule — Production, OEE Hourly, Shift OEE and
 * OEE Records — so two tabs showing the same shift name the same operator.
 * (OEE Records picked any assigned operator of its own, and could disagree
 * with Shift OEE about the same row.)
 *
 * It is the assignment now, not the one on the day: the summaries do not
 * record who ran the shift.
 */
const OPERATOR_CTE = `
  op_map AS (
    SELECT DISTINCT ON (oma.machine_id)
      oma.machine_id,
      o.id            AS operator_id,
      o.operator_name
    FROM operator_machine_assignments oma
    JOIN operators o ON o.id = oma.operator_id AND o.is_active = TRUE
    WHERE oma.is_active = TRUE
    ORDER BY oma.machine_id, oma.id DESC
  )
`;

module.exports = { OPERATOR_CTE };
