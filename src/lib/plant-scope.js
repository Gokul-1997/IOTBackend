function idOrNull(value, label) {
  if (value == null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw { status: 400, message: `${label} id is not valid` };
  return id;
}

/** Choose the explicit/owned plant, or the company's sole active plant.
 * A company with several plants needs an actual user choice. */
async function resolvePlantId(client, user, selected) {
  if (!user.company_id) throw { status: 403, message: 'No company on this account' };
  let plant = idOrNull(selected, 'Plant');
  const scope = idOrNull(user.plant_id, 'Plant');
  if (scope && plant && scope !== plant) throw { status: 403, message: 'You can only manage records in your own plant' };
  plant = scope || plant;
  if (!plant) {
    const { rows } = await client.query('SELECT id FROM plants WHERE company_id = $1 AND is_active = TRUE ORDER BY id LIMIT 2', [user.company_id]);
    if (rows.length !== 1) throw { status: 400, message: rows.length ? 'Choose a plant for this record' : 'Create a plant before adding records' };
    plant = Number(rows[0].id);
  }
  const { rows } = await client.query('SELECT id FROM plants WHERE id = $1 AND company_id = $2 AND is_active = TRUE FOR SHARE', [plant, user.company_id]);
  if (!rows.length) throw { status: 404, message: 'Plant not found' };
  return plant;
}
function effectivePlantId(user = {}) {
  // Company administration is company-wide. Other assigned users remain
  // inside their own plant, including when a request supplies another id.
  if (user.is_snt_super || (user.roles || []).some(role => ['ADMIN', 'COMPANY_ADMIN'].includes(role))) return null;
  return idOrNull(user.plant_id, 'Plant');
}

function addMachinePlantScope(conditions, params, alias, plantId) {
  if (plantId == null) return;
  params.push(plantId);
  conditions.push(`EXISTS (SELECT 1 FROM machines scoped_machine WHERE scoped_machine.id = ${alias}.machine_id
    AND scoped_machine.company_id = $1 AND scoped_machine.plant_id = $${params.length})`);
}

module.exports = { idOrNull, resolvePlantId, effectivePlantId, addMachinePlantScope };
