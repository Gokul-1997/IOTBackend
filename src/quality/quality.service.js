const db = require("../db");

const getQualityDashboardService = async ({
  machine_id,
  shift_id,
  from,
  to
}) => {

  // Machine + Operator + Current Job
  const machineInfoQuery = `
    SELECT 
      m.id,
      m.machine_name,
      o.operator_name,
      mcj.component_id,
      mcj.part_name
    FROM machines m
    LEFT JOIN machine_current_job mcj 
      ON mcj.machine_id = m.id AND mcj.is_active = true
    LEFT JOIN operators o 
      ON o.id = mcj.operator_id
    WHERE m.id = $1
  `;

  const machineInfo = await db.query(machineInfoQuery, [machine_id]);

  // Quality data
  const qualityQuery = `
    SELECT 
      COALESCE(SUM(total_qty),0) AS total_qty,
      COALESCE(SUM(reject_qty),0) AS reject_qty,
      COALESCE(SUM(rework_qty),0) AS rework_qty
    FROM quality_entries
    WHERE machine_id = $1
      AND shift_id = $2
      AND created_at::date BETWEEN $3 AND $4
  `;

  const qualityData = await db.query(qualityQuery, [
    machine_id,
    shift_id,
    from,
    to
  ]);

  const total = Number(qualityData.rows[0].total_qty);
  const reject = Number(qualityData.rows[0].reject_qty);
  const rework = Number(qualityData.rows[0].rework_qty);

  const notGood = reject + rework;
  const good = total - notGood;
  const qualityPercent =
    total > 0 ? ((good / total) * 100).toFixed(2) : 0;

  // OEE shift summary
  const oeeQuery = `
    SELECT availability, performance, quality, oee
    FROM oee_shift_summary
    WHERE machine_id = $1
      AND shift_id = $2
      AND shift_date BETWEEN $3 AND $4
    ORDER BY shift_date DESC
    LIMIT 1
  `;

  const oeeData = await db.query(oeeQuery, [
    machine_id,
    shift_id,
    from,
    to
  ]);

  // Hourly graph
  const hourlyQuery = `
    SELECT hour_start, availability, performance, quality, oee
    FROM oee_hourly
    WHERE machine_id = $1
      AND shift_id = $2
      AND hour_start::date BETWEEN $3 AND $4
    ORDER BY hour_start
  `;

  const hourlyData = await db.query(hourlyQuery, [
    machine_id,
    shift_id,
    from,
    to
  ]);

  return {
    machine: machineInfo.rows[0] || {},
    production: {
      total,
      good,
      not_good: notGood,
      reject,
      rework,
      quality_percent: Number(qualityPercent)
    },
    oee: oeeData.rows[0] || {},
    hourly: hourlyData.rows
  };
};

module.exports = {
  getQualityDashboardService
};