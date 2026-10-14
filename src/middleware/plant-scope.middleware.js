const db = require('../db');
const { effectivePlantId, idOrNull } = require('../lib/plant-scope');

/** Check the actual referenced record before a plant-bound caller can read
 * or mutate it. Null-plant/company-admin callers incur no additional query.
 * Lists/aggregates are separately scoped in their services. */
module.exports = ({ resource = null, assignee = false } = {}) => async (req, _res, next) => {
  try {
    req.plantScopeId = effectivePlantId(req.user);
    if (req.plantScopeId == null) return next();
    const params = [req.user.company_id, req.plantScopeId];
    const checks = [];
    const machineCheck = (table, foreignColumn, value, label) => {
      const id = idOrNull(value, label);
      if (id == null) return;
      params.push(id);
      checks.push(`SELECT ${checks.length} AS k, EXISTS (SELECT 1 FROM ${table} referenced
        JOIN machines scoped_machine ON scoped_machine.id = referenced.${foreignColumn}
         AND scoped_machine.company_id = referenced.company_id
        WHERE referenced.id = $${params.length} AND referenced.company_id = $1
          AND scoped_machine.company_id = $1 AND scoped_machine.plant_id = $2) AS allowed`);
    };
    const references = { ...(req.query || {}), ...(req.body || {}) };
    if (references.machine_id != null && references.machine_id !== '') {
      const id = idOrNull(references.machine_id, 'Machine');
      params.push(id);
      checks.push(`SELECT ${checks.length} AS k, EXISTS (SELECT 1 FROM machines
        WHERE id = $${params.length} AND company_id = $1 AND plant_id = $2) AS allowed`);
    }
    machineCheck('maintenance_schedules', 'machine_id', references.maintenance_schedule_id, 'Schedule');
    machineCheck('machine_alarms', 'machine_id', references.alarm_id, 'Alarm');
    if (resource === 'schedule') machineCheck('maintenance_schedules', 'machine_id', req.params.id, 'Schedule');
    if (resource === 'ticket') machineCheck('maintenance_tickets', 'machine_id', req.params.id, 'Ticket');
    if (assignee && references.assigned_to != null && references.assigned_to !== '') {
      params.push(idOrNull(references.assigned_to, 'Assignee'));
      checks.push(`SELECT ${checks.length} AS k, EXISTS (SELECT 1 FROM users WHERE id = $${params.length}
        AND company_id = $1 AND is_active = TRUE AND (plant_id = $2 OR plant_id IS NULL)) AS allowed`);
    }
    if (checks.length) {
      const { rows } = await db.query(checks.join(' UNION ALL '), params);
      if (rows.length !== checks.length || rows.some(row => row.allowed !== true)) {
        throw { status: 404, message: 'Record not found in your plant' };
      }
    }
    next();
  } catch (error) { next(error); }
};
