/** The explicitly published file for one tenant's machine, never a backup. */
const pool = require('../db');

exports.get = async (companyId, machineId) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.machine_id, m.machine_serial_no, f.folder, f.stored_name, f.program_name,
            f.kind, f.size_bytes, f.sha256, f.note, f.job_id, f.created_at,
            u.username AS uploaded_by_name, true AS is_current
       FROM program_current c
       JOIN program_files f ON f.id = c.file_id AND f.company_id = c.company_id AND f.machine_id = c.machine_id
       JOIN machines m ON m.id = c.machine_id AND m.company_id = c.company_id
       LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE c.company_id = $1 AND c.machine_id = $2 AND f.deleted_at IS NULL AND m.is_active = true`,
    [companyId, machineId]
  );
  return rows[0] || null;
};
