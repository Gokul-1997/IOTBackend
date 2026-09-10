/*
 * Phase 2 · Screen 3 — Preventive Maintenance Dashboard (read side).
 *
 * Reports on the loop that pm-engine.service.js drives: alarms cross a
 * threshold, a PM ticket is raised with a due date, the work gets done.
 *
 * A "PM ticket" is issue_type = 'PREVENTIVE'. Before migration 014 there
 * was no way to tell one from a breakdown ticket, which is why the type
 * exists at all.
 */
const db = require('../db');
const { parseDate, parseMachineId, httpError } = require('./window');

/* Stored LOW/MEDIUM/HIGH/CRITICAL; the agreement reports Critical /
   Non-Critical / Information, same mapping as Screens 1 and 2. */
const SEVERITY_CLASS = `
  CASE
    WHEN severity = 'CRITICAL'         THEN 'CRITICAL'
    WHEN severity IN ('HIGH','MEDIUM') THEN 'NON_CRITICAL'
    ELSE 'INFORMATION'
  END`;

const OPEN_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];
const TREND_DAYS = 7;

/** Page size is clamped so a caller cannot pull the whole ticket table. */
function parsePaging({ page, limit }) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const pg  = Math.max(parseInt(page, 10) || 1, 1);
  return { limit: lim, page: pg, offset: (pg - 1) * lim };
}

exports.getPreventiveDashboard = async (req) => {
  const companyId = req.user.company_id;
  const machineId = parseMachineId(req.query.machine_id);
  const day       = parseDate(req.query.date);
  const search    = (req.query.search || '').trim();
  const { limit, page, offset } = parsePaging(req.query);

  /* The date filter bounds the day in plant time, matching Screens 1 and 2
     so the same date means the same window everywhere. */
  const from = `${day}T00:00:00+05:30`;
  const to   = `${day}T23:59:59.999+05:30`;

  const alarmScope   = machineId ? 'AND a.machine_id = $4'  : '';
  const alarmParams  = machineId ? [companyId, from, to, machineId] : [companyId, from, to];
  const ticketScope  = machineId ? 'AND t.machine_id = $2'  : '';
  const ticketParams = machineId ? [companyId, machineId]   : [companyId];

  /* Ticket list: optional free-text search across the fields a technician
     would actually search by. ILIKE with a leading wildcard cannot use a
     btree index; at ticket volumes this is fine, and the alternative
     (trigram index) is not worth adding until it measurably hurts. */
  const searchIdx = machineId ? 3 : 2;
  const listWhere = `
    t.company_id = $1
    AND t.issue_type = 'PREVENTIVE'
    ${machineId ? 'AND t.machine_id = $2' : ''}
    ${search ? `AND (t.title ILIKE $${searchIdx} OR m.machine_serial_no ILIKE $${searchIdx}
                     OR COALESCE(al.alarm_type,'') ILIKE $${searchIdx})` : ''}`;
  const listParams = search ? [...ticketParams, `%${search}%`] : [...ticketParams];

  const [
    alarmKpiRes, ticketKpiRes, resolutionRes, trendRes,
    severityRes, byMachineRes, topReasonsRes, statusSplitRes,
    listRes, listCountRes, triggerRes
  ] = await Promise.all([

    /* critical alarms for the selected day */
    db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE a.is_resolved IS NOT TRUE)::int AS open
      FROM machine_alarms a
      WHERE a.company_id = $1 AND a.started_at >= $2 AND a.started_at < $3
        AND a.severity = 'CRITICAL' ${alarmScope}`, alarmParams
    ),

    /* PM ticket counts. Deliberately not date-filtered: an open ticket
       raised last week still needs attention today, and the requirement is
       "total open", not "opened on this date". */
    db.query(`
      SELECT
        COUNT(*)::int                                                          AS generated,
        COUNT(*) FILTER (WHERE t.status = ANY($${machineId ? 3 : 2}::ticket_status[]))::int AS open,
        COUNT(*) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::int         AS completed,
        COUNT(*) FILTER (WHERE t.status = ANY($${machineId ? 3 : 2}::ticket_status[])
                           AND t.due_date IS NOT NULL AND t.due_date < NOW())::int AS overdue
      FROM maintenance_tickets t
      WHERE t.company_id = $1 AND t.issue_type = 'PREVENTIVE' ${ticketScope}`,
      [...ticketParams, OPEN_STATUSES]
    ),

    /* average time from raised to resolved */
    db.query(`
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)::numeric, 1)::float
               AS avg_resolution_hours,
             COUNT(*)::int AS resolved_count
      FROM maintenance_tickets t
      WHERE t.company_id = $1 AND t.issue_type = 'PREVENTIVE'
        AND t.resolved_at IS NOT NULL ${ticketScope}`, ticketParams
    ),

    /* critical alarm trend, last 7 days ending on the selected date.
       generate_series so days with no alarms appear as zero rather than
       vanishing and making the line lie about the shape. */
    db.query(`
      WITH days AS (
        SELECT generate_series(($2::date - INTERVAL '${TREND_DAYS - 1} days')::date, $2::date, '1 day') AS d
      )
      SELECT days.d::date AS day,
             COUNT(a.id)::int AS critical
      FROM days
      LEFT JOIN machine_alarms a
        ON a.company_id = $1
       AND a.severity = 'CRITICAL'
       AND a.started_at >= days.d
       AND a.started_at <  days.d + INTERVAL '1 day'
       ${machineId ? 'AND a.machine_id = $3' : ''}
      GROUP BY days.d ORDER BY days.d`,
      machineId ? [companyId, day, machineId] : [companyId, day]
    ),

    /* alarms by severity class for the day */
    db.query(`
      SELECT ${SEVERITY_CLASS} AS class, COUNT(*)::int AS total
      FROM machine_alarms a
      WHERE a.company_id = $1 AND a.started_at >= $2 AND a.started_at < $3 ${alarmScope}
      GROUP BY 1`, alarmParams
    ),

    /* critical alarms per machine */
    db.query(`
      SELECT m.machine_serial_no, COUNT(a.id)::int AS critical
      FROM machine_alarms a
      JOIN machines m ON m.id = a.machine_id
      WHERE a.company_id = $1 AND a.started_at >= $2 AND a.started_at < $3
        AND a.severity = 'CRITICAL' ${alarmScope}
      GROUP BY m.machine_serial_no
      ORDER BY critical DESC, m.machine_serial_no
      LIMIT 15`, alarmParams
    ),

    /* top alarm reasons by occurrence */
    db.query(`
      SELECT a.alarm_type, COUNT(*)::int AS occurrences,
             COUNT(*) FILTER (WHERE a.severity = 'CRITICAL')::int AS critical
      FROM machine_alarms a
      WHERE a.company_id = $1 AND a.started_at >= $2 AND a.started_at < $3 ${alarmScope}
      GROUP BY a.alarm_type
      ORDER BY occurrences DESC
      LIMIT 10`, alarmParams
    ),

    /* PM ticket status split — the three the agreement names, with the rest
       folded in so the parts always sum to the whole */
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE t.status = 'OPEN')::int                    AS open,
        COUNT(*) FILTER (WHERE t.status IN ('ASSIGNED','IN_PROGRESS'))::int AS in_progress,
        COUNT(*) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::int    AS completed
      FROM maintenance_tickets t
      WHERE t.company_id = $1 AND t.issue_type = 'PREVENTIVE' ${ticketScope}`,
      ticketParams
    ),

    /* the open PM ticket list */
    db.query(`
      SELECT
        t.id AS ticket_id,
        m.machine_serial_no,
        al.alarm_type    AS alarm_name,
        th.threshold_count,
        al.started_at    AS triggered_at,
        t.priority,
        t.status,
        t.created_at,
        t.due_date,
        u.username       AS assigned_to_name,
        ROUND(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600)::int AS age_hours,
        (t.due_date IS NOT NULL AND t.due_date < NOW() AND t.status <> ALL($${listParams.length + 1}::ticket_status[]))
          AS is_overdue
      FROM maintenance_tickets t
      LEFT JOIN machines m          ON m.id  = t.machine_id
      LEFT JOIN machine_alarms al   ON al.id = t.alarm_id
      LEFT JOIN alarm_thresholds th ON th.id = t.threshold_id
      LEFT JOIN users u             ON u.id  = t.assigned_to
      WHERE ${listWhere}
      ORDER BY (t.due_date IS NULL), t.due_date ASC, t.created_at DESC
      LIMIT $${listParams.length + 2} OFFSET $${listParams.length + 3}`,
      [...listParams, ['RESOLVED', 'CLOSED'], limit, offset]
    ),

    db.query(`
      SELECT COUNT(*)::int AS total
      FROM maintenance_tickets t
      LEFT JOIN machines m        ON m.id  = t.machine_id
      LEFT JOIN machine_alarms al ON al.id = t.alarm_id
      WHERE ${listWhere}`, listParams
    ),

    /* alarm trigger summary: the rule, how often it fired, how many PM
       tickets it produced. This is what migration 014's rules table exists
       for — before it there was nowhere to read "threshold" from. */
    db.query(`
      SELECT
        th.id, th.alarm_type, th.threshold_count, th.window_hours,
        th.due_hours, th.priority, th.is_active,
        mm.machine_serial_no AS scope_machine,
        COALESCE(trig.occurrences, 0)::int AS occurrences,
        COALESCE(tk.tickets, 0)::int       AS tickets_created
      FROM alarm_thresholds th
      LEFT JOIN machines mm ON mm.id = th.machine_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS occurrences
        FROM machine_alarms a
        WHERE a.company_id = th.company_id
          AND a.alarm_type = th.alarm_type
          AND (th.machine_id IS NULL OR a.machine_id = th.machine_id)
          AND a.started_at >= $2 AND a.started_at < $3
      ) trig ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS tickets
        FROM maintenance_tickets t2
        WHERE t2.threshold_id = th.id
      ) tk ON TRUE
      WHERE th.company_id = $1
      ORDER BY occurrences DESC, th.alarm_type`,
      [companyId, from, to]
    )
  ]);

  const severity = { critical: 0, non_critical: 0, information: 0 };
  for (const r of severityRes.rows) {
    if (r.class === 'CRITICAL')          severity.critical     = r.total;
    else if (r.class === 'NON_CRITICAL') severity.non_critical = r.total;
    else                                 severity.information  = r.total;
  }

  const total = listCountRes.rows[0].total;

  return {
    filters: { date: day, machine_id: machineId, search: search || null },
    updated_at: new Date().toISOString(),

    kpis: {
      critical_alarms:      alarmKpiRes.rows[0].total,
      critical_alarms_open: alarmKpiRes.rows[0].open,
      pm_generated:         ticketKpiRes.rows[0].generated,
      pm_open:              ticketKpiRes.rows[0].open,
      pm_completed:         ticketKpiRes.rows[0].completed,
      pm_overdue:           ticketKpiRes.rows[0].overdue,
      avg_resolution_hours: resolutionRes.rows[0].avg_resolution_hours,
      resolved_count:       resolutionRes.rows[0].resolved_count
    },

    alarm_trend:     trendRes.rows,
    alarm_severity:  severity,
    alarms_by_machine: byMachineRes.rows,
    top_alarm_reasons: topReasonsRes.rows,
    ticket_status:   statusSplitRes.rows[0] || { open: 0, in_progress: 0, completed: 0 },

    tickets: {
      data: listRes.rows,
      total,
      page,
      limit,
      totalPages: Math.max(Math.ceil(total / limit), 1)
    },

    alarm_triggers: triggerRes.rows
  };
};

/* ── threshold rule management ──────────────────────────────── */

exports.listThresholds = async (companyId) => {
  const { rows } = await db.query(
    `SELECT th.*, m.machine_serial_no
     FROM alarm_thresholds th
     LEFT JOIN machines m ON m.id = th.machine_id
     WHERE th.company_id = $1
     ORDER BY th.alarm_type`, [companyId]
  );
  return rows;
};

exports.upsertThreshold = async (companyId, body, userId) => {
  const alarmType = (body.alarm_type || '').trim();
  if (!alarmType) throw httpError('alarm_type is required', 400);

  const machineId = parseMachineId(body.machine_id);
  const nums = {
    threshold_count: parseInt(body.threshold_count, 10) || 3,
    window_hours:    parseInt(body.window_hours, 10)    || 24,
    due_hours:       parseInt(body.due_hours, 10)       || 48
  };
  for (const [k, v] of Object.entries(nums)) {
    if (v <= 0) throw httpError(`${k} must be greater than zero`, 400);
  }

  const priority = String(body.priority || 'MEDIUM').toUpperCase();
  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(priority)) {
    throw httpError('priority must be LOW, MEDIUM, HIGH or CRITICAL', 400);
  }

  /* If a machine is named it must belong to the caller's company — the id
     comes straight from the client. */
  if (machineId) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM machines WHERE id = $1 AND company_id = $2`, [machineId, companyId]
    );
    if (!rowCount) throw httpError('Machine not found or access denied', 404);
  }

  /* Two partial unique indexes cover this, so the conflict target has to
     match whichever one applies. */
  const conflict = machineId
    ? '(company_id, machine_id, alarm_type) WHERE machine_id IS NOT NULL'
    : '(company_id, alarm_type) WHERE machine_id IS NULL';

  const { rows } = await db.query(
    `INSERT INTO alarm_thresholds
       (company_id, machine_id, alarm_type, threshold_count, window_hours,
        due_hours, priority, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, TRUE),$9)
     ON CONFLICT ${conflict} DO UPDATE SET
       threshold_count = EXCLUDED.threshold_count,
       window_hours    = EXCLUDED.window_hours,
       due_hours       = EXCLUDED.due_hours,
       priority        = EXCLUDED.priority,
       is_active       = EXCLUDED.is_active,
       updated_at      = NOW()
     RETURNING *`,
    [companyId, machineId, alarmType, nums.threshold_count, nums.window_hours,
     nums.due_hours, priority, body.is_active, userId]
  );
  return rows[0];
};

exports.deleteThreshold = async (companyId, id) => {
  const { rowCount } = await db.query(
    `DELETE FROM alarm_thresholds WHERE id = $1 AND company_id = $2`,
    [parseMachineId(id), companyId]
  );
  if (!rowCount) throw httpError('Threshold not found or access denied', 404);
};
