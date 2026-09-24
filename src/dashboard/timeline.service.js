/*
 * The machine page's shift timeline: the current shift as one bar of
 * Running / Idle / Alarm / Off periods, with the shift's breaks marked on it.
 *
 * Built from telemetry_raw, which carries a sample every few seconds. Only
 * the points where the state changes, or where the samples stop, are read
 * back (a window function over the shift) — about 10,000 samples a shift
 * come back as a few hundred rows at most, in ~50 ms on the machine index.
 *
 * The state of a sample is the one the machine list shows:
 *   - ALARM    the alarm flag is on (a machine in alarm has stopped),
 *   - RUNNING  RUN / RUNNING / CUTTING,
 *   - IDLE     anything else the machine reports,
 *   - OFF      no sample for longer than a minute — the list's own offline
 *              threshold — or nothing yet this shift.
 */
const db = require('../db');

const GAP_MS   = 60 * 1000;
const IST_MS   = 330 * 60 * 1000;
const DAY_MIN  = 1440;

const httpError = (message, status) => Object.assign(new Error(message), { status });
const hm = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const istDate = ms => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istTime = ms => new Date(ms + IST_MS).toISOString().slice(11, 19);
const atIST = (date, time) => Date.parse(`${date}T${String(time).slice(0, 8)}+05:30`);

/** The shift running now — the same test the machine page's detail uses. */
async function currentShift(companyId) {
  const { rows } = await db.query(`
    SELECT id, shift_code, shift_name, start_time, end_time, break_minutes
      FROM shifts
     WHERE company_id = $1 AND is_active = true
       AND ((start_time <= end_time
             AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time BETWEEN start_time AND end_time)
         OR (start_time > end_time
             AND ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time >= start_time
               OR (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time <= end_time)))
     LIMIT 1`, [companyId]);
  return rows[0] || null;
}

/** This instance of the shift, in epoch ms. A night shift that began
 *  yesterday evening started yesterday. Plant time throughout, whatever
 *  zone the server runs in. */
function shiftWindow(shift, nowMs) {
  const today = istDate(nowMs);
  const crossesMidnight = shift.start_time > shift.end_time;
  const beganYesterday = crossesMidnight && istTime(nowMs) < String(shift.start_time);
  const startDate = beganYesterday ? istDate(nowMs - DAY_MIN * 60000) : today;
  const start = atIST(startDate, shift.start_time);
  const length = ((hm(shift.end_time) - hm(shift.start_time) + DAY_MIN) % DAY_MIN) || DAY_MIN;
  return { start, end: start + length * 60000 };
}

/** Break windows placed on this instance of the shift. Empty until
 *  migration 028 exists; `configured` says which. */
async function breaksFor(shift, companyId, start) {
  try {
    const { rows } = await db.query(
      `SELECT break_name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
         FROM shift_breaks WHERE shift_id = $1 AND company_id = $2`, [shift.id, companyId]);
    const s0 = hm(shift.start_time);
    const list = rows.map(b => {
      const off = (hm(b.start_time) - s0 + DAY_MIN) % DAY_MIN;
      const dur = (hm(b.end_time) - hm(b.start_time) + DAY_MIN) % DAY_MIN;
      return { name: b.break_name, from: start + off * 60000, to: start + (off + dur) * 60000 };
    }).sort((a, b) => a.from - b.from);
    return { configured: true, list };
  } catch (err) {
    if (err.code === '42P01') return { configured: false, list: [] };   // before 028
    throw err;
  }
}

/**
 * Turn the change points into contiguous periods covering [start, upto].
 * `rows` are the samples where the state changed or the samples had
 * stopped for over a minute (t, st, prev_t in ms); `lastT` the last sample.
 */
function buildSegments(rows, lastT, start, upto) {
  const segs = [];
  const push = (state, from, to) => {
    from = Math.max(from, start); to = Math.min(to, upto);
    if (to <= from) return;
    const prev = segs[segs.length - 1];
    if (prev && prev.state === state && prev.to >= from) { prev.to = Math.max(prev.to, to); return; }
    segs.push({ state, from, to });
  };

  if (!rows.length) { push('OFF', start, upto); return segs; }

  // a first sample within a minute of the start is the state at the start
  let cur = { state: rows[0].st, from: rows[0].t - start <= GAP_MS ? start : rows[0].t };
  if (cur.from > start) push('OFF', start, cur.from);

  for (const r of rows.slice(1)) {
    const stopped = r.prev_t !== null && r.t - r.prev_t > GAP_MS;
    if (stopped) { push(cur.state, cur.from, r.prev_t); push('OFF', r.prev_t, r.t); }
    else push(cur.state, cur.from, r.t);
    cur = { state: r.st, from: r.t };
  }

  // still reporting: the last state runs to now; gone quiet: off since
  if (upto - lastT > GAP_MS) { push(cur.state, cur.from, lastT); push('OFF', lastT, upto); }
  else push(cur.state, cur.from, upto);
  return segs;
}

/** Milliseconds of [from, to] that fall inside [a, b]. */
const overlap = (from, to, a, b) => Math.max(0, Math.min(to, b) - Math.max(from, a));

exports.machineTimeline = async (machineId, companyId, nowMs = Date.now()) => {
  const id = Number(machineId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('machine_id must be a positive integer', 400);

  const { rows: m } = await db.query(
    `SELECT id FROM machines WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!m.length) return null;

  const shift = await currentShift(companyId);
  if (!shift) return { shift: null, now: nowMs, segments: [], breaks: [], breaks_configured: true, totals: null };

  const { start, end } = shiftWindow(shift, nowMs);
  const upto = Math.min(nowMs, end);

  const [changes, last, breaks] = await Promise.all([
    db.query(`
      WITH s AS (
        SELECT received_at AS t,
               CASE WHEN alarm THEN 'ALARM'
                    WHEN UPPER(machine_status) IN ('RUN', 'RUNNING', 'CUTTING') THEN 'RUNNING'
                    ELSE 'IDLE' END AS st
          FROM telemetry_raw
         WHERE machine_id = $1 AND received_at >= $2 AND received_at <= $3
      ), c AS (
        SELECT t, st, LAG(st) OVER w AS prev_st, LAG(t) OVER w AS prev_t
          FROM s WINDOW w AS (ORDER BY t)
      )
      SELECT (EXTRACT(EPOCH FROM t) * 1000)::bigint AS t, st,
             (EXTRACT(EPOCH FROM prev_t) * 1000)::bigint AS prev_t
        FROM c
       WHERE prev_st IS DISTINCT FROM st OR t - prev_t > INTERVAL '60 seconds'
       ORDER BY t`,
      [id, new Date(start), new Date(upto)]),
    db.query(`
      SELECT (EXTRACT(EPOCH FROM MAX(received_at)) * 1000)::bigint AS last
        FROM telemetry_raw
       WHERE machine_id = $1 AND received_at >= $2 AND received_at <= $3`,
      [id, new Date(start), new Date(upto)]),
    breaksFor(shift, companyId, start)
  ]);

  const rows = changes.rows.map(r => ({ t: Number(r.t), st: r.st, prev_t: r.prev_t === null ? null : Number(r.prev_t) }));
  const segments = buildSegments(rows, Number(last.rows[0]?.last) || start, start, upto);

  const totals = { elapsed: upto - start, RUNNING: 0, IDLE: 0, ALARM: 0, OFF: 0, breaks: 0 };
  for (const s of segments) totals[s.state] += s.to - s.from;
  for (const b of breaks.list) totals.breaks += overlap(b.from, b.to, start, upto);

  return {
    shift: {
      id: shift.id, code: shift.shift_code, name: shift.shift_name,
      start, end, break_minutes: shift.break_minutes
    },
    now: nowMs,
    segments,
    breaks: breaks.list,
    breaks_configured: breaks.configured,
    totals
  };
};

exports._internal = { buildSegments, shiftWindow };
