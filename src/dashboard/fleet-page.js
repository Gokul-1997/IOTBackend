const db = require('../db');

function parseFleetPage(query = {}) {
  if (query.paged === undefined) return null; // legacy app contract
  const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (query.paged !== '1') invalid('paged must be 1');
  const positive = (raw, fallback, max, name) => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) invalid(`${name} must be a positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) invalid(`${name} must not exceed ${max}`);
    return value;
  };
  const page = positive(query.page, 1, 100000, 'page');
  const perPage = positive(query.per_page, 25, 100, 'per_page');
  const status = query.status ?? 'all';
  if (!['all', 'running', 'idle', 'alarm', 'offline'].includes(status)) invalid('Invalid machine status');
  const search = query.search ?? '';
  if (typeof search !== 'string' || search.length > 100) invalid('search must be at most 100 characters');
  return { page, perPage, status, search: search.trim() };
}

async function fleetPage(companyId, options) {
  if (!companyId) throw Object.assign(new Error('No company assigned'), { status: 403 });
  const { page, perPage, status, search } = options;
  // The latest-reading lookup is indexed and time bounded. Full production,
  // job and operator calculations below run only for the returned page IDs.
  // Counts and page rows share one SQL snapshot, including when the page is empty.
  const { rows } = await db.query(`
    WITH fleet AS MATERIALIZED (
      SELECT m.id, m.machine_serial_no, m.image_url,
             t.machine_status, COALESCE(t.alarm, false) AS alarm, t.received_at,
             CASE WHEN t.received_at IS NULL OR t.received_at < NOW() - INTERVAL '60 seconds' THEN 'OFFLINE'
                  WHEN UPPER(t.machine_status) IN ('RUN','RUNNING','CUTTING') THEN 'RUNNING'
                  ELSE 'IDLE' END AS status
        FROM machines m
        LEFT JOIN LATERAL (
          SELECT machine_status, alarm, received_at FROM telemetry_raw
           WHERE company_id = $1 AND machine_id = m.id
             AND received_at > NOW() - INTERVAL '1 hour'
           ORDER BY received_at DESC LIMIT 1
        ) t ON true
       WHERE m.company_id = $1 AND m.is_active = true
    ), filtered AS (
      SELECT * FROM fleet
       WHERE ($4 = 'all' OR ($4 = 'alarm' AND alarm) OR status = UPPER($4))
         AND ($5 = '' OR strpos(lower(machine_serial_no), lower($5)) > 0)
    )
    SELECT (SELECT json_build_object(
             'total', count(*), 'running', count(*) FILTER (WHERE status = 'RUNNING'),
             'idle', count(*) FILTER (WHERE status = 'IDLE'),
             'offline', count(*) FILTER (WHERE status = 'OFFLINE'),
             'alarm', count(*) FILTER (WHERE alarm)) FROM fleet) AS summary,
           (SELECT count(*)::int FROM filtered) AS total,
           COALESCE((SELECT json_agg(p ORDER BY p.id) FROM
             (SELECT * FROM filtered ORDER BY id LIMIT $2 OFFSET $3) p), '[]'::json) AS machines
  `, [companyId, perPage, (page - 1) * perPage, status, search]);
  const result = rows[0];
  return {
    machines: result.machines,
    summary: result.summary,
    pagination: { page, per_page: perPage, total: result.total, total_pages: Math.max(1, Math.ceil(result.total / perPage)) }
  };
}

module.exports = { parseFleetPage, fleetPage };
