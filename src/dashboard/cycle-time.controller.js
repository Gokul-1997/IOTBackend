const db = require('../db');
const { plantSql } = require('../lib/read-scope');
const { parseMachineId, resolveWindow } = require('./window');

function cycleTrend(rows) {
  return rows.map(row => {
    const produced = Number(row.produced);
    const run = row.run_seconds == null ? NaN : Number(row.run_seconds);
    return { hour_start: row.hour_start, produced: Number.isFinite(produced) && produced >= 0 ? produced : 0,
      cycle_seconds: Number.isFinite(produced) && produced > 0 && Number.isFinite(run) && run >= 0
        ? Math.round(run / produced * 10) / 10 : null };
  });
}

async function getCycleTime(machineId, companyId, query = {}) {
  const id = parseMachineId(machineId);
  if (!id) throw Object.assign(new Error('machine_id must be a positive integer'), { status: 400 });
  const owned = await db.query(`SELECT id, machine_serial_no FROM machines
    WHERE id = $1 AND company_id = $2 AND is_active${plantSql('id')}`, [id, companyId]);
  if (!owned.rows.length) return null;
  const win = await resolveWindow(companyId, query);
  const result = await db.query(`SELECT p.hour_start,
      SUM(p.produced_qty)::float AS produced, SUM(p.run_seconds)::float AS run_seconds
    FROM production_hourly p
    JOIN machines m ON m.id = p.machine_id AND m.company_id = $1 AND m.is_active
    WHERE p.company_id = $1 AND p.machine_id = $4${plantSql('p.machine_id')}
      AND p.hour_start >= $2 AND p.hour_start < $3 AND p.hour_start <= NOW()
      ${win.shift ? 'AND p.shift_id = $5' : ''}
    GROUP BY p.hour_start ORDER BY p.hour_start`,
  [companyId, win.from, win.to, id, ...(win.shift ? [win.shift.id] : [])]);
  return { machine: owned.rows[0], date: win.day, shift_id: win.shift?.id ?? null,
    points: cycleTrend(result.rows), basis: 'Recorded running seconds divided by parts produced in each hour. Hours without parts have no cycle time.' };
}

exports.getCycleTime = getCycleTime;
exports.cycleTrend = cycleTrend;
exports.read = async (req, res) => {
  try {
    const data = await getCycleTime(req.params.machine_id, req.user.company_id, req.query);
    return data ? res.json({ status: 'success', data }) : res.status(404).json({ status: 'error', message: 'Machine not found' });
  } catch (error) {
    return res.status(error.status || 500).json({ status: 'error', message: error.status ? error.message : 'Unable to load cycle times' });
  }
};
