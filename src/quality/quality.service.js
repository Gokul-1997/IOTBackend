const db = require("../db");
const { ownedOrThrow } = require("../lib/tenant");
const historical = require("../lib/historical-production");
const { plantSql } = require("../lib/read-scope");

function qualityDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('date must be a valid YYYY-MM-DD calendar date.'), { status: 400 });
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('date must be a valid YYYY-MM-DD calendar date.'), { status: 400 });
  }
  return value;
}

// ─────────────────────────────────────────────────────────────
// Helper: shift planned seconds (duration minus break)
// ─────────────────────────────────────────────────────────────
function shiftPlannedSeconds(shift) {
  const [sh, sm] = shift.start_time.split(":").map(Number);
  const [eh, em] = shift.end_time.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  const durationMin = endMin > startMin
    ? endMin - startMin
    : 1440 - startMin + endMin;
  return Math.max(1, durationMin - Number(shift.break_minutes || 0)) * 60;
}

// ─────────────────────────────────────────────────────────────
// GET QUALITY DASHBOARD
// ─────────────────────────────────────────────────────────────
exports.getQualityDashboardService = async ({ company_id, machine_id, shift_id, date }) => {
  date = qualityDate(date);
  // Validate the referenced machine and shared/owned shift before reading totals.
  await ownedOrThrow(company_id, { machine_id, shift_id });

  // 1. Machine info + target
  const { rows: machineRows } = await db.query(
    `SELECT
       m.id,
       m.machine_serial_no,
       m.image_url,
       COALESCE(o.operator_name, '-')    AS operator_name,
       COALESCE(c.part_number, '')       AS component_id,
       COALESCE(mcj.part_name, '-')      AS part_name,
       COALESCE(c.operation_number, '')  AS operation_number,
       COALESCE(mcj.target_qty, 0)       AS target_qty,
       EXTRACT(EPOCH FROM COALESCE(c.cycle_time, '0'))::int AS cycle_time_seconds,
       COALESCE(c.multiplication_factor, 1)               AS multiplication_factor
     FROM machines m
     LEFT JOIN machine_current_job mcj
       ON mcj.machine_id = m.id AND mcj.is_active = TRUE
     LEFT JOIN components c ON c.id = mcj.component_id
     LEFT JOIN operators o ON o.id = (
       SELECT oma.operator_id
       FROM operator_machine_assignments oma
       INNER JOIN operator_shift_assignments osa
         ON osa.operator_id = oma.operator_id
        AND osa.shift_id = $2
        AND osa.is_active = TRUE
        AND (osa.effective_to IS NULL OR osa.effective_to >= $3::date)
       WHERE oma.machine_id = m.id
         AND oma.is_active = TRUE
         AND (oma.assigned_to IS NULL OR oma.assigned_to >= $3::date)
       LIMIT 1
     )
     WHERE m.id = $1 AND m.company_id = $4`,
    [machine_id, shift_id, date, company_id]
  );

  const machine = machineRows[0] || {};

  // 2. Shift info (for planned seconds)
  const { rows: shiftRows } = await db.query(
    `SELECT start_time, end_time, break_minutes FROM shifts WHERE id = $1 AND company_id = $2`,
    [shift_id, company_id]
  );
  const shift = shiftRows[0];
  const plannedSeconds = shift ? shiftPlannedSeconds(shift) : 0;

  // Read the bounded shift once; reuse its rows for totals and the chart.
  const { rows: hourlyRows } = await db.query(historical.rowsSQL, [company_id, [Number(machine_id)], shift_id, date]);
  const produced = hourlyRows.reduce((sum, row) => sum + Number(row.produced_qty || 0), 0);

  // 4. Quality entries (reject + rework)
  const { rows: qRows } = await db.query(
    `SELECT
       COALESCE(SUM(reject_qty), 0) AS reject,
       COALESCE(SUM(rework_qty), 0) AS rework
     FROM quality_entries
     WHERE machine_id = $1
       AND shift_id   = $2
       AND COALESCE(shift_date, (created_at AT TIME ZONE 'Asia/Kolkata')::date) = $3::date`,
    [machine_id, shift_id, date]
  );

  const reject   = Number(qRows[0].reject);
  const rework   = Number(qRows[0].rework);
  const accepted = Math.max(0, produced - reject - rework);
  const quality_percent = produced > 0
    ? +((accepted / produced) * 100).toFixed(2)
    : null;

  // GET is read-only. Scheduled rollups persist summaries; opening a dashboard
  // must never change historical results using the currently active component.
  const oee = historical.metrics(hourlyRows, plannedSeconds, accepted);
  const hourlyQualityKnown = reject === 0 && rework === 0;
  const hourly = hourlyRows.map(h => {
    const hProduced = Number(h.produced_qty || 0);
    return {
      hour: h.hour_start, run_seconds: Number(h.run_seconds || 0), idle_seconds: Number(h.idle_seconds || 0), produced_qty: hProduced,
      accepted: hourlyQualityKnown ? hProduced : null,
      reject: hourlyQualityKnown ? 0 : null, rework: hourlyQualityKnown ? 0 : null,
      measurement_basis: hourlyQualityKnown ? 'SHIFT_HAS_NO_REJECTS' : 'HOURLY_QUALITY_NOT_MEASURED',
      ...historical.metrics([h], Number(h.planned_seconds || 3600), hourlyQualityKnown ? hProduced : null)
    };
  });

  return {
    machine: {
      id:               machine.id,
      machine_serial_no: machine.machine_serial_no,
      image_url:         machine.image_url,
      operator_name:     machine.operator_name,
      component_id:      machine.component_id,
      part_name:         machine.part_name,
      operation_number:  machine.operation_number,
      target_qty:        Number(machine.target_qty || 0)
    },
    production: {
      target_qty: Number(machine.target_qty || 0),
      produced,
      accepted,
      reject,
      rework,
      quality_percent
    },
    oee,
    hourly
  };
};

// ─────────────────────────────────────────────────────────────
// UPSERT reject / rework for a machine + shift + date
// ─────────────────────────────────────────────────────────────
exports.upsertQualityEntryService = async ({
  company_id,
  machine_id,
  shift_id,
  date,
  reject_qty,
  rework_qty,
  user_id
}) => {
  date = qualityDate(date);
  reject_qty = Number(reject_qty);
  rework_qty = Number(rework_qty);
  if (![reject_qty, rework_qty].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw Object.assign(new Error('Reject and rework quantities must be non-negative whole numbers.'), { status: 400 });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await ownedOrThrow(company_id, { machine_id, shift_id }, client);
    // This parent row exists even before the first quality entry. Locking it
    // serializes two first saves as well as later edits, on every API server.
    const { rows: machines } = await client.query(
      `SELECT id FROM machines WHERE id=$1 AND company_id=$2${plantSql('id')} FOR UPDATE`,
      [machine_id, company_id]
    );
    if (!machines.length) throw Object.assign(new Error('Machine not found'), { status: 404 });
    // Include the first partial hour of a shift, with the same overlap rule as
    // the historical dashboard. Never count another company's rollup rows.
    const { rows: prodRows } = await client.query(
      `SELECT COALESCE(SUM(produced_qty), 0) AS produced
       FROM production_hourly ph
       JOIN shifts s ON s.id = ph.shift_id AND s.company_id=$4
       WHERE ph.company_id=$4 AND ph.machine_id = $1
         AND ph.shift_id   = $2
         AND ph.hour_start + INTERVAL '1 hour' > ($3::date + s.start_time) AT TIME ZONE 'Asia/Kolkata'
         AND ph.hour_start <  (
               CASE WHEN s.start_time >= s.end_time
                    THEN ($3::date + INTERVAL '1 day' + s.end_time)
                    ELSE ($3::date + s.end_time)
               END
             ) AT TIME ZONE 'Asia/Kolkata'`,
      [machine_id, shift_id, date, company_id]
    );
    const produced = Number(prodRows[0]?.produced || 0);
    if (produced > 0 && (reject_qty + rework_qty) > produced) {
      const err = new Error(`Reject (${reject_qty}) + Rework (${rework_qty}) cannot exceed produced quantity (${produced})`);
      err.status = 422;
      throw err;
    }

    const { rows: existing } = await client.query(
      `SELECT id FROM quality_entries
       WHERE machine_id = $1
         AND shift_id   = $2
         AND COALESCE(shift_date, (created_at AT TIME ZONE 'Asia/Kolkata')::date) = $3::date
       ORDER BY id
       LIMIT 2 FOR UPDATE`,
      [machine_id, shift_id, date]
    );

    if (existing.length > 1) {
      throw Object.assign(new Error('Multiple quality totals exist for this machine, shift and date. An administrator must review them before saving.'), {
        status: 409, code: 'QUALITY_TOTALS_AMBIGUOUS'
      });
    }

    if (existing.length > 0) {
      await client.query(
        `UPDATE quality_entries
         SET reject_qty = $1, rework_qty = $2, entered_by = $3, shift_date = $4
         WHERE id = $5`,
        [reject_qty, rework_qty, user_id, date, existing[0].id]
      );
      await client.query('COMMIT');
      return { action: "updated" };
    }

    await client.query(
      `INSERT INTO quality_entries (machine_id, shift_id, shift_date, reject_qty, rework_qty, entered_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [machine_id, shift_id, date, reject_qty, rework_qty, user_id]
    );
    await client.query('COMMIT');
    return { action: "created" };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};
