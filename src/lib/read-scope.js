const { AsyncLocalStorage } = require('node:async_hooks');
const { effectivePlantId, idOrNull } = require('./plant-scope');

// Authorization context follows this request's async work, including report
// preparation after a 202. Cron workers have no request context and stay
// company-wide. SQL predicates below are inserted explicitly by each reader;
// this module never intercepts or rewrites database queries.
const requests = new AsyncLocalStorage();
function run(user, work) {
  return requests.run({ companyId: idOrNull(user.company_id, 'Company'), plantId: effectivePlantId(user) }, work);
}
function current() { return requests.getStore(); }
function resolved(plantId, companyId) {
  const auth = current();
  return auth || { plantId: idOrNull(plantId, 'Plant'), companyId: idOrNull(companyId, 'Company') };
}
function plantSql(machineColumn, plantId, companyId) {
  const scope = resolved(plantId, companyId);
  if (scope.plantId == null) return '';
  if (!scope.companyId) throw Object.assign(new Error('No company assigned'), { status: 403 });
  if (!/^[a-z_][a-z_0-9]*(\.[a-z_][a-z_0-9]*)?$/i.test(machineColumn)) throw new Error('Invalid scoped SQL column');
  // IDs are validated positive safe integers from server authorization, never
  // SQL text or request filters. Keeping them in this constant predicate avoids
  // disturbing the bind positions of the existing reporting query builders.
  return ` AND ${machineColumn} IN (SELECT authorized_machine.id FROM machines authorized_machine WHERE authorized_machine.company_id = ${scope.companyId} AND authorized_machine.plant_id = ${scope.plantId})`;
}
function entityPlantSql(alias, plantId, companyId) {
  const scope = resolved(plantId, companyId);
  if (scope.plantId == null) return '';
  if (!/^[a-z_][a-z_0-9]*$/i.test(alias)) throw new Error('Invalid scoped SQL alias');
  return ` AND ${alias}.plant_id = ${scope.plantId}`;
}
function sharedEntityPlantSql(alias, plantId, companyId) {
  const clause = entityPlantSql(alias, plantId, companyId);
  return clause ? ` AND (${alias}.plant_id IS NULL OR (TRUE ${clause}))` : '';
}
function nullablePlantSql(machineColumn) {
  const clause = plantSql(machineColumn);
  return clause ? ` AND (${machineColumn} IS NULL OR (TRUE ${clause}))` : '';
}
function cacheScope() { return current()?.plantId ?? 'company'; }
module.exports = { run, current, resolved, plantSql, entityPlantSql, sharedEntityPlantSql, nullablePlantSql, cacheScope };
