const pool = require('../db');
const crypto = require('crypto');
const { cleanHourRate } = require('./hour-rate');
const { cleanSpecs } = require('./machine-specs');
const { pagination } = require('../lib/pagination');
const { idOrNull, resolvePlantId } = require('../lib/plant-scope');
const placements = require('../lib/machine-placement');
const { validateImageReference } = require('../files/media.service');

const EDITABLE = ['machine_serial_no', 'line_id', 'plant_id', 'x_axis', 'y_axis', 'z_axis',
  'fourth_axis', 'fifth_axis', 'twin_spindle', 'twin_table', 'atc_tool_capacity', 'model',
  'mmc_no', 'controller', 'spindle_rpm', 'image_url', 'hour_rate', 'program_path', 'controller_type'];
async function lockCompany(client, companyId) {
  if (!companyId) throw { status: 403, message: 'No company on this account' };
  const { rows } = await client.query('SELECT id FROM companies WHERE id = $1 AND is_active = TRUE FOR UPDATE', [companyId]);
  if (!rows.length) throw { status: 404, message: 'Company not found' };
}
async function enforceQuota(client, companyId) {
  const { rows } = await client.query(
    `SELECT COALESCE(cp.max_machines, p.max_machines) AS max_machines
       FROM company_plans cp LEFT JOIN plans p ON p.id = cp.plan_id
      WHERE cp.company_id = $1 AND cp.is_active = TRUE LIMIT 1`, [companyId]
  );
  const max = rows[0]?.max_machines;
  if (max == null) return;
  const count = await client.query('SELECT COUNT(*)::int AS n FROM machines WHERE company_id = $1 AND is_active = TRUE', [companyId]);
  if (count.rows[0].n >= Number(max)) throw { status: 402, message: `Machine limit reached for this plan (${count.rows[0].n}/${max}). Upgrade plan to add more.` };
}
async function placement(client, data, user, current = {}) {
  const company = user.company_id;
  let plantId = idOrNull(data.plant_id !== undefined ? data.plant_id : current.plant_id, 'Plant');
  const ownPlant = idOrNull(user.plant_id, 'Plant');
  if (ownPlant && plantId && ownPlant !== plantId) throw { status: 403, message: 'You can only manage machines in your own plant' };
  plantId = ownPlant || plantId;
  const lineId = idOrNull(data.line_id !== undefined ? data.line_id : current.line_id, 'Line');
  if (lineId) {
    const { rows } = await client.query('SELECT id, plant_id FROM line WHERE id = $1 AND company_id = $2 FOR SHARE', [lineId, company]);
    if (!rows.length) throw { status: 404, message: 'Line not found' };
    const linePlant = idOrNull(rows[0].plant_id, 'Plant');
    if (!linePlant) throw { status: 400, message: 'Assign a plant to the selected line first' };
    if (linePlant && plantId && linePlant !== plantId) throw { status: 400, message: 'The selected line belongs to a different plant' };
    plantId ||= linePlant;
  }
  plantId = await resolvePlantId(client, user, plantId);
  return { plantId, lineId };
}

/* Quota, placement, machine and its shift links are one atomic change. */
exports.createMachine = async (req) => {
  const serial = String(req.body.machine_serial_no || '').trim();
  if (!serial || serial.length > 100) throw { status: 400, message: 'Machine serial number is required (maximum 100 characters)' };
  const hourRate = cleanHourRate(req.body.hour_rate);
  const specs = cleanSpecs(req.body);
  const client = await pool.connect();
  let routingWrite;
  try {
    await client.query('BEGIN');
    await lockCompany(client, req.user.company_id);
    await enforceQuota(client, req.user.company_id);
    const { plantId, lineId } = await placement(client, req.body, req.user);
    const imageUrl = await validateImageReference({ user: req.user, imageUrl: req.body.image_url, plantId, client });
    const columns = ['plant_id', 'company_id', 'line_id', 'machine_serial_no',
      'x_axis', 'y_axis', 'z_axis', 'fourth_axis', 'fifth_axis', 'twin_spindle', 'twin_table',
      'atc_tool_capacity', 'model', 'mmc_no', 'controller', 'spindle_rpm', 'image_url', 'hour_rate', 'api_key', 'program_path', 'controller_type'];
    const params = [plantId, req.user.company_id, lineId, serial,
      ...columns.slice(4, 17).map(key => key === 'image_url' ? imageUrl : specs[key] ?? null), hourRate, crypto.randomBytes(16).toString('hex'),
      specs.program_path ?? null, specs.controller_type ?? null];
    const { rows } = await client.query(
      `INSERT INTO machines (${columns.join(', ')}) VALUES (${params.map((_, i) => '$' + (i + 1)).join(', ')})
       RETURNING id, plant_id, machine_serial_no, api_key`, params
    );
    routingWrite = placements.begin(rows[0].id);
    await client.query(
      `INSERT INTO machine_shift_config (plant_id, machine_id, shift_id)
       SELECT $1, $2, id FROM shifts WHERE company_id = $3 AND is_active = TRUE
         AND (plant_id IS NULL OR plant_id = $1)`, [plantId, rows[0].id, req.user.company_id]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); await placements.finish(routingWrite, pool); }
};

/* LIST MACHINES */
exports.getMachines = async (req) => {

  const {
    search = '',
    page = 1,
    limit = 10,
    sortBy = 'm.id',
    sortDir = 'desc'
  } = req.query;

  const companyId = req.user.company_id;
  const { limitNum, offset } = pagination(page, limit);

  const sortableColumns = [
    'm.id',
    'm.machine_serial_no',
    'm.model',
    'm.controller',
    'm.spindle_rpm',
    'm.is_active',
    'l.name'     // FIX: was 'l.line_name' but column is 'name' in line table
  ];

  const orderColumn = sortableColumns.includes(sortBy)
    ? sortBy
    : 'm.id';

  const orderDirection =
    String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let whereSQL = `WHERE m.company_id = $1`;
  const values = [companyId];
  const plantId = req.user.plant_id || idOrNull(req.query.plant_id, 'Plant');
  if (plantId) { values.push(plantId); whereSQL += ` AND m.plant_id = $${values.length}`; }

  if (search) {
    values.push(`%${search}%`);

    whereSQL += `
      AND (
        m.machine_serial_no ILIKE $${values.length}
        OR m.model ILIKE $${values.length}
        OR m.controller ILIKE $${values.length}
        OR l.name ILIKE $${values.length}    /* FIX: was l.line_name (wrong column name) */
      )
    `;
  }

  const dataQuery = `
    SELECT 
      m.id,
      m.machine_serial_no,
      m.plant_id,
      m.line_id,
      l.name,
      m.image_url,
      m.x_axis,
      m.y_axis,
      m.z_axis,
      m.fourth_axis,
      m.fifth_axis,
      m.twin_spindle,
      m.twin_table,
      m.atc_tool_capacity,
      m.model,
      m.mmc_no,
      m.controller,
      m.controller_type,
      m.spindle_rpm,
      m.hour_rate,
      m.api_key,
      m.program_path,
      m.is_active,
      m.created_at
    FROM machines m
    LEFT JOIN line l ON l.id = m.line_id
    ${whereSQL}
    ORDER BY ${orderColumn} ${orderDirection}
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    FROM machines m
    LEFT JOIN line l ON l.id = m.line_id
    ${whereSQL}
  `;

  const [dataRes, countRes] = await Promise.all([
    pool.query(dataQuery, [...values, limitNum, offset]),
    pool.query(countQuery, values)
  ]);

  return {
    data: dataRes.rows,
    total: countRes.rows[0]?.total || 0
  };
};

async function scopedMachine(client, req, lock = '') {
  const { rows } = await client.query(
    `SELECT id, plant_id, line_id, is_active, image_url FROM machines
      WHERE id = $1 AND company_id = $2 AND ($3::int IS NULL OR plant_id = $3) ${lock}`,
    [idOrNull(req.params.id, 'Machine'), req.user.company_id, req.user.plant_id ?? null]
  );
  if (!rows.length) throw { status: 404, message: 'Machine not found' };
  return rows[0];
}

exports.toggleMachineStatus = async (req) => {
  const routingWrite = placements.begin(idOrNull(req.params.id, 'Machine'));
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await lockCompany(client, req.user.company_id);
    const machine = await scopedMachine(client, req, 'FOR UPDATE');
    if (!machine.is_active) await enforceQuota(client, req.user.company_id);
    await client.query('UPDATE machines SET is_active = $1 WHERE id = $2 AND company_id = $3', [!machine.is_active, machine.id, req.user.company_id]);
    await client.query('COMMIT');
  } catch (err) { if (client) await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client?.release(); await placements.finish(routingWrite, pool); }
};

exports.regenerateApiKey = async (req) => {
  const newKey = crypto.randomBytes(16).toString('hex');
  const result = await pool.query(
    `UPDATE machines SET api_key = $1
      WHERE id = $2 AND company_id = $3 AND ($4::int IS NULL OR plant_id = $4) RETURNING id`,
    [newKey, idOrNull(req.params.id, 'Machine'), req.user.company_id, req.user.plant_id ?? null]
  );
  if (!result.rowCount) throw { status: 404, message: 'Machine not found' };
  return newKey;
};

exports.deleteMachine = async (req) => {
  const routingWrite = placements.begin(idOrNull(req.params.id, 'Machine'));
  try {
  const result = await pool.query(
    `DELETE FROM machines WHERE id = $1 AND company_id = $2 AND ($3::int IS NULL OR plant_id = $3) RETURNING id`,
    [idOrNull(req.params.id, 'Machine'), req.user.company_id, req.user.plant_id ?? null]
  );
  if (!result.rowCount) throw { status: 404, message: 'Machine not found' };
  } finally { await placements.finish(routingWrite, pool); }
};

exports.updateMachine = async (req) => {
  const patch = Object.fromEntries(EDITABLE.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
  if ('hour_rate' in patch) patch.hour_rate = cleanHourRate(patch.hour_rate);
  Object.assign(patch, cleanSpecs(patch));
  if (!Object.keys(patch).length) throw { status: 400, message: 'No fields provided for update' };
  if ('machine_serial_no' in patch) {
    patch.machine_serial_no = String(patch.machine_serial_no || '').trim();
    if (!patch.machine_serial_no || patch.machine_serial_no.length > 100) throw { status: 400, message: 'Machine serial number is required (maximum 100 characters)' };
  }
  const needsPlacement = 'plant_id' in patch || 'line_id' in patch;
  const needsTransaction = needsPlacement || 'image_url' in patch;
  const routingWrite = placements.begin(idOrNull(req.params.id, 'Machine'));
  let client;
  let previousPlantId;
  try {
    client = needsTransaction ? await pool.connect() : pool;
    if (needsTransaction) {
      await client.query('BEGIN');
      const current = await scopedMachine(client, req, 'FOR UPDATE');
      if (needsPlacement) {
        previousPlantId = current.plant_id;
        const { plantId, lineId } = await placement(client, patch, req.user, current);
        patch.plant_id = plantId; patch.line_id = lineId;
      }
      if ('image_url' in patch) {
        patch.image_url = await validateImageReference({ user: req.user, imageUrl: patch.image_url,
          plantId: patch.plant_id ?? current.plant_id, existingImageUrl: current.image_url, client });
      }
    }
    const keys = Object.keys(patch), values = Object.values(patch);
    values.push(idOrNull(req.params.id, 'Machine'), req.user.company_id, req.user.plant_id ?? null);
    const result = await client.query(
      `UPDATE machines SET ${keys.map((key, i) => `${key} = $${i + 1}`).join(', ')}
        WHERE id = $${keys.length + 1} AND company_id = $${keys.length + 2}
          AND ($${keys.length + 3}::int IS NULL OR plant_id = $${keys.length + 3}) RETURNING *`, values
    );
    if (!result.rowCount) throw { status: 404, message: 'Machine not found' };
    if (needsPlacement) {
      if (Number(previousPlantId) !== patch.plant_id) {
        // Keep explicit settings for shared/current-plant shifts. A move
        // must not leave the machine running its former plant's timetable.
        await client.query(`DELETE FROM machine_shift_config configured
          WHERE configured.machine_id=$1 AND NOT EXISTS (
            SELECT 1 FROM shifts s WHERE s.id=configured.shift_id AND s.company_id=$2
              AND (s.plant_id IS NULL OR s.plant_id=$3))`, [result.rows[0].id, req.user.company_id, patch.plant_id]);
        await client.query(`INSERT INTO machine_shift_config (plant_id, machine_id, shift_id)
          SELECT $1,$2,s.id FROM shifts s WHERE s.company_id=$3 AND s.is_active=TRUE
            AND (s.plant_id IS NULL OR s.plant_id=$1)
            AND NOT EXISTS (SELECT 1 FROM machine_shift_config configured WHERE configured.machine_id=$2 AND configured.shift_id=s.id)`,
        [patch.plant_id, result.rows[0].id, req.user.company_id]);
      }
      await client.query('UPDATE machine_shift_config SET plant_id = $1 WHERE machine_id = $2', [patch.plant_id, result.rows[0].id]);
    }
    if (needsTransaction) await client.query('COMMIT');
    const { ftp_pass, ftp_port, ftp_user, ftp_dir, ip_address, ...machine } = result.rows[0];
    return machine;
  } catch (err) {
    if (needsTransaction && client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { if (needsTransaction) client?.release(); await placements.finish(routingWrite, pool); }
};
