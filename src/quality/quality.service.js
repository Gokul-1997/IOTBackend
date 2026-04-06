const db = require("../db");

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
// Helper: OEE from raw numbers
// ─────────────────────────────────────────────────────────────
function calcOee({ runSeconds, plannedSeconds, producedQty, cycleTimeSec, accepted, multFactor = 1 }) {
  const availability = plannedSeconds > 0
    ? Math.min(100, (runSeconds / plannedSeconds) * 100)
    : 0;

  // idealQty = how many parts should have been made in run time (× factor for multi-part fixtures)
  const idealQty    = cycleTimeSec > 0 ? (runSeconds / cycleTimeSec) * multFactor : 0;
  const actualQty   = producedQty * multFactor;
  const performance = idealQty > 0
    ? Math.min(100, (actualQty / idealQty) * 100)
    : 0;

  const quality = producedQty > 0
    ? Math.min(100, (accepted / producedQty) * 100)
    : 0;

  const oee = (availability / 100) * (performance / 100) * (quality / 100) * 100;

  return {
    availability: +availability.toFixed(2),
    performance:  +performance.toFixed(2),
    quality:      +quality.toFixed(2),
    oee:          +oee.toFixed(2)
  };
}

// ─────────────────────────────────────────────────────────────
// GET QUALITY DASHBOARD
// ─────────────────────────────────────────────────────────────
exports.getQualityDashboardService = async ({ machine_id, shift_id, date }) => {

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
     WHERE m.id = $1`,
    [machine_id, shift_id, date]
  );

  const machine = machineRows[0] || {};
  const cycleTimeSec = Number(machine.cycle_time_seconds || 0);
  const multFactor   = Number(machine.multiplication_factor || 1);

  // 2. Shift info (for planned seconds)
  const { rows: shiftRows } = await db.query(
    `SELECT start_time, end_time, break_minutes FROM shifts WHERE id = $1`,
    [shift_id]
  );
  const shift = shiftRows[0];
  const plannedSeconds = shift ? shiftPlannedSeconds(shift) : 0;

  // 3. Production totals from production_hourly
  //    Use logical shift_date: hours before shift.start_time belong to previous day's shift
  const { rows: prodRows } = await db.query(
    `SELECT
       COALESCE(SUM(produced_qty), 0)  AS produced,
       COALESCE(SUM(run_seconds), 0)   AS run_seconds
     FROM production_hourly ph
     JOIN shifts s ON s.id = ph.shift_id
     WHERE ph.machine_id = $1
       AND ph.shift_id   = $2
       AND CASE
             WHEN (ph.hour_start AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time
             THEN DATE(ph.hour_start AT TIME ZONE 'Asia/Kolkata')
             ELSE DATE(ph.hour_start AT TIME ZONE 'Asia/Kolkata') - 1
           END = $3::date`,
    [machine_id, shift_id, date]
  );

  const produced   = Number(prodRows[0].produced);
  const runSeconds = Number(prodRows[0].run_seconds);

  // 4. Quality entries (reject + rework)
  const { rows: qRows } = await db.query(
    `SELECT
       COALESCE(SUM(reject_qty), 0) AS reject,
       COALESCE(SUM(rework_qty), 0) AS rework
     FROM quality_entries
     WHERE machine_id = $1
       AND shift_id   = $2
       AND created_at::date = $3::date`,
    [machine_id, shift_id, date]
  );

  const reject   = Number(qRows[0].reject);
  const rework   = Number(qRows[0].rework);
  const accepted = Math.max(0, produced - reject - rework);
  const quality_percent = produced > 0
    ? +((accepted / produced) * 100).toFixed(2)
    : 0;

  // 5. OEE — calculated on the fly from production_hourly + quality_entries
  const oee = calcOee({ runSeconds, plannedSeconds, producedQty: produced, cycleTimeSec, accepted, multFactor });

  // Also upsert oee_shift_summary so future reads are fast
  if (produced > 0 && shift) {
    await db.query(
      `INSERT INTO oee_shift_summary
         (machine_id, shift_id, shift_date, availability, performance, quality, oee)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (machine_id, shift_id, shift_date)
       DO UPDATE SET
         availability = EXCLUDED.availability,
         performance  = EXCLUDED.performance,
         quality      = EXCLUDED.quality,
         oee          = EXCLUDED.oee`,
      [machine_id, shift_id, date, oee.availability, oee.performance, oee.quality, oee.oee]
    );
  }

  // 6. Hourly chart — per hour OEE from production_hourly
  const { rows: hourlyRows } = await db.query(
    `SELECT
       ph.hour_start,
       COALESCE(ph.run_seconds, 0)   AS run_seconds,
       COALESCE(ph.idle_seconds, 0)  AS idle_seconds,
       COALESCE(ph.produced_qty, 0)  AS produced_qty
     FROM production_hourly ph
     JOIN shifts s ON s.id = ph.shift_id
     WHERE ph.machine_id = $1
       AND ph.shift_id   = $2
       AND CASE
             WHEN (ph.hour_start AT TIME ZONE 'Asia/Kolkata')::time >= s.start_time
             THEN DATE(ph.hour_start AT TIME ZONE 'Asia/Kolkata')
             ELSE DATE(ph.hour_start AT TIME ZONE 'Asia/Kolkata') - 1
           END = $3::date
     ORDER BY ph.hour_start`,
    [machine_id, shift_id, date]
  );

  // Distribute reject+rework proportionally across hours by produced_qty
  const hourly = hourlyRows.map((h) => {
    const hProduced   = Number(h.produced_qty);
    const hRunSeconds = Number(h.run_seconds);

    // Proportional reject/rework for this hour
    const ratio      = produced > 0 ? hProduced / produced : 0;
    const hReject    = Math.round(reject * ratio);
    const hRework    = Math.round(rework * ratio);
    const hAccepted  = Math.max(0, hProduced - hReject - hRework);

    // For hourly availability, use 3600s as the hour window (1 hour)
    const hourPlanned = 3600;
    const oeeH = calcOee({
      runSeconds:    hRunSeconds,
      plannedSeconds: hourPlanned,
      producedQty:   hProduced,
      cycleTimeSec,
      accepted:      hAccepted,
      multFactor
    });

    return {
      hour: h.hour_start,
      run_seconds:  hRunSeconds,
      idle_seconds: Number(h.idle_seconds),
      produced_qty: hProduced,
      accepted:     hAccepted,
      reject:       hReject,
      rework:       hRework,
      ...oeeH
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
  machine_id,
  shift_id,
  date,
  reject_qty,
  rework_qty,
  user_id
}) => {
  const { rows: existing } = await db.query(
    `SELECT id FROM quality_entries
     WHERE machine_id = $1
       AND shift_id   = $2
       AND created_at::date = $3::date
     ORDER BY created_at DESC
     LIMIT 1`,
    [machine_id, shift_id, date]
  );

  if (existing.length > 0) {
    await db.query(
      `UPDATE quality_entries
       SET reject_qty = $1, rework_qty = $2, entered_by = $3
       WHERE id = $4`,
      [reject_qty, rework_qty, user_id, existing[0].id]
    );
    return { action: "updated" };
  }

  await db.query(
    `INSERT INTO quality_entries (machine_id, shift_id, reject_qty, rework_qty, entered_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [machine_id, shift_id, reject_qty, rework_qty, user_id]
  );
  return { action: "created" };
};
