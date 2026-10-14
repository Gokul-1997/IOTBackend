const db = require('../db');
const { pagination } = require('../lib/pagination');
const { ownedOrThrow } = require('../lib/tenant');

async function lockMachine(client, machineId, companyId, plantId) {
  const { rows } = await client.query(
    `SELECT id, plant_id FROM machines WHERE id = $1 AND company_id = $2 AND is_active = TRUE
       AND ($3::int IS NULL OR plant_id = $3) FOR UPDATE`, [machineId, companyId, plantId ?? null]
  );
  if (!rows.length) throw { status: 404, message: 'Machine not found' };
  return rows[0];
}

/** Auto-switch keeps the existing behavior, but ends the old occurrence
 * instead of rewriting history and its captured cycle time. */
async function switchActive(client, component, machine, companyId, onlyComponent = null) {
  const result = await client.query(
    `UPDATE machine_current_job SET is_active = FALSE, ended_at = NOW(), setting_time_end = NOW()
      WHERE machine_id = $1 AND company_id = $2 AND is_active = TRUE
        AND ($3::int IS NULL OR component_id = $3) RETURNING id`,
    [machine.id, companyId, onlyComponent]
  );
  if (result.rowCount) {
    await client.query(
      `INSERT INTO machine_current_job
         (plant_id, company_id, machine_id, component_id, part_name, target_qty, started_at, cycle_time_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)`,
      [machine.plant_id, companyId, machine.id, component.id, component.part_name, component.target, component.cycle_time_seconds]
    );
  }
}

exports.create = async (data, plant_id, company_id) => {
  await ownedOrThrow(company_id, { machine_id: data.machine_id });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const machine = await lockMachine(client, data.machine_id, company_id, plant_id);
    const { rows } = await client.query(
      `INSERT INTO components
         (plant_id, company_id, machine_id, part_name, part_number, operation_number, cycle_time, target, multiplication_factor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *, EXTRACT(EPOCH FROM cycle_time) AS cycle_time_seconds`,
      [machine.plant_id, company_id, data.machine_id, data.part_name, data.part_number,
       data.operation_number, data.cycle_time, data.target, data.multiplication_factor || 1]
    );
    await switchActive(client, rows[0], machine, company_id);
    await client.query('COMMIT');
    return { status: 'success', data: rows[0] };
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
};

/* ===========================
   LIST WITH SEARCH + PAGINATION
=========================== */
exports.list = async (plant_id, query, company_id) => {

  const { pageNum: page, limitNum: limit, offset } = pagination(query.page, query.limit || 6);
  const search = query.search || '';

  const machine_id = query.machine_id || '';

  const values = [company_id];
  let where = `WHERE c.company_id = $1 AND m.company_id = $1`;

  if (plant_id != null) {
    values.push(plant_id);
    where += ` AND m.plant_id = $${values.length}`;
  }

  if (machine_id) {
    values.push(machine_id);
    where += ` AND c.machine_id = $${values.length}`;
  }

  if (search) {
    values.push(`%${search}%`);
    where += `
      AND (
        c.part_name ILIKE $${values.length}
        OR c.part_number ILIKE $${values.length}
        OR m.machine_serial_no ILIKE $${values.length}
      )
    `;
  }

  const totalQuery = `
    SELECT COUNT(*) AS total
    FROM components c
    JOIN machines m ON m.id = c.machine_id
    ${where}
  `;

  const listQuery = `
    SELECT c.*, m.machine_serial_no
    FROM components c
    JOIN machines m ON m.id = c.machine_id
    ${where}
    ORDER BY c.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totalRes = await db.query(totalQuery, values);
  const dataRes = await db.query(listQuery, values);

  return {
    status: 'success',
    data: dataRes.rows,
    meta: {
      page,
      limit,
      total: parseInt(totalRes.rows[0]?.total || 0),
      totalPages: Math.ceil(Number(totalRes.rows[0]?.total || 0) / limit)
    }
  };
};

/* UPDATE */
exports.update = async (id, data, plant_id, company_id) => {
  await ownedOrThrow(company_id, { component_id: id });
  const editable = ['part_name', 'part_number', 'operation_number', 'cycle_time', 'target', 'multiplication_factor'];
  const keys = editable.filter(key => data[key] !== undefined);
  if (!keys.length) throw { status: 400, message: 'Nothing to update' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // All job and component changes take the machine lock first. Looking up
    // its immutable component association does not need a component lock.
    const current = await client.query('SELECT id, machine_id FROM components WHERE id = $1 AND company_id = $2', [id, company_id]);
    if (!current.rows.length) throw { status: 404, message: 'Component not found' };
    const machine = await lockMachine(client, current.rows[0].machine_id, company_id, plant_id);
    const locked = await client.query('SELECT id, part_name, target, EXTRACT(EPOCH FROM cycle_time) AS cycle_time_seconds FROM components WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, company_id]);
    if (!locked.rows.length) throw { status: 404, message: 'Component not found' };
    const values = keys.map(key => data[key]); values.push(id, company_id);
    const { rows } = await client.query(
      `UPDATE components SET ${keys.map((key, i) => `${key} = $${i + 1}`).join(', ')}
        WHERE id = $${values.length - 1} AND company_id = $${values.length}
        RETURNING *, EXTRACT(EPOCH FROM cycle_time) AS cycle_time_seconds`, values
    );
    // Changing a catalogue code/operation/multiplier alone does not alter
    // the production snapshot, so it should not fragment an active job.
    const before = locked.rows[0], after = rows[0];
    if (after.part_name !== before.part_name || Number(after.target) !== Number(before.target)
      || Number(after.cycle_time_seconds) !== Number(before.cycle_time_seconds)) {
      await switchActive(client, rows[0], machine, company_id, id);
    }
    await client.query('COMMIT');
    return { status: 'success', data: rows[0] };
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }
};

/* DELETE */
exports.remove = async (id, plant_id, company_id) => {

  const result = await db.query(`
    DELETE FROM components c USING machines m
    WHERE c.id=$1 AND c.company_id=$2 AND m.id=c.machine_id AND m.company_id=$2
      AND ($3::int IS NULL OR m.plant_id=$3)
    RETURNING c.id
  `, [id, company_id, plant_id ?? null]);
  if (!result.rowCount) throw { status: 404, message: 'Component not found' };

  return { status: 'success' };
};
