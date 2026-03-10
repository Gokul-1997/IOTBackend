const db = require("../db");

exports.getQualityDashboardService = async ({
  machine_id,
  shift_id,
  from,
  to
}) => {

  // MACHINE INFO
const machineInfo = await db.query(
  `
  SELECT 
    m.id,
    m.machine_serial_no,
    m.image_url,
    COALESCE(o.operator_name, '-') AS operator_name,
    COALESCE(mcj.component_id, '-') AS component_id,
    COALESCE(mcj.part_name, '-') AS part_name

  FROM machines m

  LEFT JOIN machine_current_job mcj
    ON mcj.machine_id = m.id
   AND mcj.is_active = true

  LEFT JOIN operators o ON o.id = (
      SELECT oma.operator_id
      FROM operator_machine_assignments oma
      INNER JOIN operator_shift_assignments osa
        ON osa.operator_id = oma.operator_id
       AND osa.shift_id = $2
       AND osa.is_active = true
       AND (osa.effective_to IS NULL OR osa.effective_to >= $3::date)

      WHERE oma.machine_id = m.id
        AND oma.is_active = true
        AND (oma.assigned_to IS NULL OR oma.assigned_to >= $3::date)

      LIMIT 1
  )

  WHERE m.id = $1

  `,
  [machine_id, shift_id, from]
);

  // QUALITY
  const qualityData = await db.query(
    `SELECT 
        COALESCE(SUM(total_qty),0) AS total,
        COALESCE(SUM(reject_qty),0) AS reject,
        COALESCE(SUM(rework_qty),0) AS rework
     FROM quality_entries
     WHERE machine_id = $1
       AND shift_id = $2
       AND created_at::date BETWEEN $3 AND $4`,
    [machine_id, shift_id, from, to]
  );

  const total = Number(qualityData.rows[0].total);
  const reject = Number(qualityData.rows[0].reject);
  const rework = Number(qualityData.rows[0].rework);
  const not_good = reject + rework;
  const good = total - not_good;

  const quality_percent =
    total > 0 ? Number(((good / total) * 100).toFixed(2)) : 0;

  // OEE
  const oeeData = await db.query(
    `SELECT
        COALESCE(availability,0) AS availability,
        COALESCE(performance,0) AS performance,
        COALESCE(quality,0) AS quality,
        COALESCE(oee,0) AS oee
     FROM oee_shift_summary
     WHERE machine_id = $1
       AND shift_id = $2
       AND shift_date BETWEEN $3 AND $4
     ORDER BY shift_date DESC
     LIMIT 1`,
    [machine_id, shift_id, from, to]
  );

  const oee = oeeData.rows[0] || {
    availability: 0,
    performance: 0,
    quality: 0,
    oee: 0
  };

  // HOURLY
  const hourlyData = await db.query(
    `SELECT hour_start,
            COALESCE(availability,0) AS availability,
            COALESCE(performance,0) AS performance,
            COALESCE(quality,0) AS quality,
            COALESCE(oee,0) AS oee
     FROM oee_hourly
     WHERE machine_id = $1
       AND shift_id = $2
       AND hour_start::date BETWEEN $3 AND $4
     ORDER BY hour_start`,
    [machine_id, shift_id, from, to]
  );

  return {
    machine: machineInfo.rows[0] || {},
    production: {
      total,
      good,
      not_good,
      reject,
      rework,
      quality_percent
    },
    oee,
    hourly: hourlyData.rows
  };
};

