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
const { severityClass } = require('./severity');
const { parseRange, parseMachineId, httpError } = require('./window');

/* Critical / Non-Critical / Information — one definition, see severity.js. */
const SEVERITY_CLASS = severityClass('severity');

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
  const search    = (req.query.search || '').trim();
  const { limit, page, offset } = parsePaging(req.query);

  /* A From–To range, as the design draws it ("18 Jun 2026 - 18 Jul 2026");
     it was a single day, which could not show a week or a month at all.
     Bounded in plant time, like Screens 1 and 2. A legacy ?date= still
     means that one day. */
  const range = parseRange(req.query);
  const { start: from, end: to } = range;

  const alarmScope   = machineId ? 'AND a.machine_id = $4'  : '';
  const alarmParams  = machineId ? [companyId, from, to, machineId] : [companyId, from, to];

  /* The ticket cards count PM tickets raised in the range, so every card
     moves with the dates: "3 open of 12 raised" is then about the same 12.
     They used to ignore the date entirely, so changing it changed nothing. */
  const ticketScope  = `AND t.created_at >= $2 AND t.created_at <= $3 ${machineId ? 'AND t.machine_id = $4' : ''}`;
  const ticketParams = machineId ? [companyId, from, to, machineId] : [companyId, from, to];
  const statusIdx    = ticketParams.length + 1;

  /* The critical alarm trend covers the range, and never fewer than the
     seven days the agreement names — a one-day range still shows its week. */
  const trendFrom = range.days >= TREND_DAYS ? range.from
    : new Date(Date.parse(`${range.to}T00:00:00Z`) - (TREND_DAYS - 1) * 86400000).toISOString().slice(0, 10);

  /* The ticket list is the backlog to work through, so it is not bounded by
     the dates: a ticket raised last month and still open needs doing today. */
  const listBase = machineId ? [companyId, machineId] : [companyId];

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
  const listParams = search ? [...listBase, `%${search}%`] : [...listBase];

  const [
    alarmKpiRes, ticketKpiRes, resolutionRes, trendRes,
    severityRes, byMachineRes, topReasonsRes, statusSplitRes,
    listRes, listCountRes, triggerRes
  ] = await Promise.all([

    /* critical alarms in the range */
    db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE a.is_resolved IS NOT TRUE)::int AS open
      FROM machine_alarms a
      WHERE a.company_id = $1 AND a.started_at >= $2 AND a.started_at < $3
        AND a.severity = 'CRITICAL' ${alarmScope}`, alarmParams
    ),

    /* PM tickets raised in the range: how many, and where they stand now */
    db.query(`
      SELECT
        COUNT(*)::int                                                          AS generated,
        COUNT(*) FILTER (WHERE t.status = ANY($${statusIdx}::ticket_status[]))::int AS open,
        COUNT(*) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::int         AS completed,
        COUNT(*) FILTER (WHERE t.status = ANY($${statusIdx}::ticket_status[])
                           AND t.due_date IS NOT NULL AND t.due_date < NOW())::int AS overdue
      FROM maintenance_tickets t
      WHERE t.company_id = $1 AND t.issue_type = 'PREVENTIVE' ${ticketScope}`,
      [...ticketParams, OPEN_STATUSES]
    ),

    /* average time from raised to resolved, for tickets raised in the range */
    db.query(`
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)::numeric, 1)::float
               AS avg_resolution_hours,
             COUNT(*)::int AS resolved_count
      FROM maintenance_tickets t
      WHERE t.company_id = $1 AND t.issue_type = 'PREVENTIVE'
        AND t.resolved_at IS NOT NULL ${ticketScope}`, ticketParams
    ),

    /* critical alarm trend, one point per plant-time day across the range.
       generate_series so days with no alarms appear as zero rather than
       vanishing and making the line lie about the shape. Days are cut at
       IST midnight: comparing to a bare date used the database session's
       zone, which put a 02:00 IST alarm on the previous day. */
    db.query(`
      WITH days AS (
        SELECT generate_series($2::date, $3::date, '1 day')::date AS d
      )
      SELECT days.d AS day,
             COUNT(a.id)::int AS critical
      FROM days
      LEFT JOIN machine_alarms a
        ON a.company_id = $1
       AND a.severity = 'CRITICAL'
       AND a.started_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND a.started_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
       AND (a.started_at AT TIME ZONE 'Asia/Kolkata')::date = days.d
       ${machineId ? 'AND a.machine_id = $4' : ''}
      GROUP BY days.d ORDER BY days.d`,
      machineId ? [companyId, trendFrom, range.to, machineId] : [companyId, trendFrom, range.to]
    ),

    /* alarms by severity class in the range */
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

    /* PM ticket status split for tickets raised in the range — the three
       the agreement names, with the rest folded in so the parts always sum
       to the whole */
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
          AND t2.created_at >= $2 AND t2.created_at <= $3
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
    filters: {
      from: range.from, to: range.to, days: range.days,
      date: range.to,               // older clients read this
      machine_id: machineId, search: search || null
    },
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
