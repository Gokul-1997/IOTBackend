const pool = require('../db');

/* =====================================================
   HELPERS
===================================================== */

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function calculateDuration(startMin, endMin) {
  if (endMin > startMin) {
    return endMin - startMin;
  }
  // Night shift
  return (1440 - startMin) + endMin;
}

function validateShiftInput(start_time, end_time, breakMin) {
  const startMin = timeToMinutes(start_time);
  const endMin = timeToMinutes(end_time);

  const duration = calculateDuration(startMin, endMin);

  if (duration <= 0 || duration > 1440) {
    throw new Error('Invalid shift duration');
  }

  if (breakMin < 0) {
    throw new Error('Break minutes cannot be negative');
  }

  if (breakMin >= duration) {
    throw new Error('Break cannot be greater than or equal to shift duration');
  }

  return { startMin, endMin, duration };
}

async function validateOverlap(company_id, startMin, duration, ignoreId = null) {

  const existing = await pool.query(`
    SELECT id, start_time, end_time
    FROM shifts
    WHERE company_id = $1
      AND is_active = TRUE
      ${ignoreId ? 'AND id != $2' : ''}
  `, ignoreId ? [company_id, ignoreId] : [company_id]);

  const newStart = startMin;
  const newEnd = startMin + duration;

  for (const row of existing.rows) {

    const eStart = timeToMinutes(row.start_time);
    const eEnd = timeToMinutes(row.end_time);

    const eDuration = calculateDuration(eStart, eEnd);

    const oldStart = eStart;
    const oldEnd = eStart + eDuration;

    const overlap =
      newStart < oldEnd && newEnd > oldStart;

    if (overlap) {
      throw new Error('Shift overlaps with existing shift');
    }
  }
}

/* =====================================================
   GET SHIFTS
===================================================== */

exports.getShifts = async (req) => {

  const result = await pool.query(`
    SELECT
      id,
      shift_code,
      shift_name,
      start_time,
      end_time,
      break_minutes,
      is_active
    FROM shifts
    WHERE company_id = $1
    ORDER BY start_time
  `, [req.user.company_id]);

  return result.rows;
};

/* =====================================================
   CREATE SHIFT
===================================================== */

exports.createShift = async (req) => {

  const {
    shift_code,
    shift_name,
    start_time,
    end_time,
    break_minutes
  } = req.body;

  if (!shift_code || !start_time || !end_time) {
    throw new Error('Shift code, start time and end time are required');
  }

  const breakMin = Number(break_minutes || 0);

  const dup = await pool.query(
    `SELECT id FROM shifts WHERE company_id = $1 AND shift_code = $2`,
    [req.user.company_id, shift_code]
  );
  if (dup.rowCount > 0) throw new Error('A shift with this code already exists');

  const { startMin, duration } =
    validateShiftInput(start_time, end_time, breakMin);

  await validateOverlap(req.user.company_id, startMin, duration);

  const result = await pool.query(`
    INSERT INTO shifts
    (plant_id, company_id, shift_code, shift_name, start_time, end_time, break_minutes)
    VALUES (NULL,$1,$2,$3,$4,$5,$6)
    RETURNING id
  `, [
    req.user.company_id,
    shift_code,
    shift_name || null,
    start_time,
    end_time,
    breakMin
  ]);

  const newShiftId = result.rows[0].id;

  await pool.query(`
    INSERT INTO machine_shift_config (plant_id, machine_id, shift_id)
    SELECT NULL, id, $1
    FROM machines
    WHERE company_id = $2
  `, [newShiftId, req.user.company_id]);

  return { message: 'Shift created successfully' };
};

/* =====================================================
   UPDATE SHIFT
===================================================== */

exports.updateShift = async (id, data, company_id) => {

  const existing = await pool.query(`
    SELECT * FROM shifts
    WHERE id = $1 AND company_id = $2
  `, [id, company_id]);

  if (!existing.rowCount) {
    throw new Error('Shift not found');
  }

  const current = existing.rows[0];

  if (data.shift_code && data.shift_code !== current.shift_code) {
    const dup = await pool.query(
      `SELECT id FROM shifts WHERE company_id = $1 AND shift_code = $2 AND id != $3`,
      [company_id, data.shift_code, id]
    );
    if (dup.rowCount > 0) throw new Error('A shift with this code already exists');
  }

  const start_time = data.start_time ?? current.start_time;
  const end_time = data.end_time ?? current.end_time;
  const breakMin = Number(data.break_minutes ?? current.break_minutes);

  const { startMin, duration } =
    validateShiftInput(start_time, end_time, breakMin);

  // Only re-check overlap when times actually changed — avoids false positives
  // when only shift_code / shift_name / break_minutes is being updated.
  const timesChanged = data.start_time !== undefined || data.end_time !== undefined;
  if (timesChanged) {
    await validateOverlap(company_id, startMin, duration, id);
  }

  const result = await pool.query(`
    UPDATE shifts
    SET shift_code = $1,
        shift_name = $2,
        start_time = $3,
        end_time = $4,
        break_minutes = $5
    WHERE id = $6 AND company_id = $7
    RETURNING *
  `, [
    data.shift_code ?? current.shift_code,
    data.shift_name ?? current.shift_name,
    start_time,
    end_time,
    breakMin,
    id,
    company_id
  ]);

  return result.rows[0];
};

/* =====================================================
   DELETE SHIFT
===================================================== */

exports.deleteShift = async (id, company_id) => {
  const existing = await pool.query(`
    SELECT id FROM shifts WHERE id = $1 AND company_id = $2
  `, [id, company_id]);

  if (!existing.rowCount) {
    throw new Error('Shift not found');
  }

  // Remove or nullify all FK references before deleting the shift
  await pool.query(`DELETE FROM oee_shift_summary WHERE shift_id = $1`, [id]);
  await pool.query(`DELETE FROM oee_hourly WHERE shift_id = $1`, [id]);
  await pool.query(`DELETE FROM production_hourly WHERE shift_id = $1`, [id]);
  await pool.query(`UPDATE quality_entries SET shift_id = NULL WHERE shift_id = $1`, [id]);
  await pool.query(`DELETE FROM machine_shift_config WHERE shift_id = $1`, [id]);
  await pool.query(`DELETE FROM shifts WHERE id = $1 AND company_id = $2`, [id, company_id]);
};

/* =====================================================
   TOGGLE SHIFT
===================================================== */

exports.toggleShift = async (req) => {

  const { id } = req.params;
  const { is_active } = req.body;

  await pool.query(`
    UPDATE shifts
    SET is_active = $1
    WHERE id = $2 AND company_id = $3
  `, [is_active, id, req.user.company_id]);

};