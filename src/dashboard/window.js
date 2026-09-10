/*
 * Shared time-window resolution for the Phase 2 analytics dashboards.
 *
 * Extracted from factory.service.js when the Maintenance dashboard needed
 * exactly the same behaviour: every analytics screen takes the same
 * date + shift + machine filter trio and must resolve them identically, or
 * two screens filtered the same way would disagree with each other.
 */

const db = require('../db');

/** Client mistakes must not surface as 500s — they pollute error monitoring
 *  and tell the caller the server is broken when the request was. */
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Reject anything that is not a real calendar date.
 *
 * Without this a value like "not-a-date" was interpolated straight into
 * "not-a-dateT00:00:00+05:30" and handed to Postgres, which raised a type
 * error the controller then reported as 500.
 */
function parseDate(date) {
  if (!date) return new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw httpError('date must be in YYYY-MM-DD format', 400);
  }
  // catches 2026-02-31 and friends, which match the pattern but do not exist
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError(`${date} is not a valid date`, 400);
  }
  return date;
}

/**
 * A machine filter must be a positive integer.
 *
 * Number('abc') is NaN, which used to reach the query as a bind parameter
 * rather than being refused up front.
 */
function parseMachineId(machineId) {
  if (machineId === undefined || machineId === null || machineId === '') return null;
  const n = Number(machineId);
  if (!Number.isInteger(n) || n <= 0) {
    throw httpError('machine_id must be a positive integer', 400);
  }
  return n;
}

/**
 * Turn a date (+ optional shift) into a concrete [from, to) window.
 *
 * Times are built in +05:30 because the plants are in India and the server
 * may not be — see the TZ note in ecosystem.config.js.
 */
async function resolveWindow(companyId, { date, shift_id }) {
  const day = parseDate(date);

  if (!shift_id) {
    return {
      from: `${day}T00:00:00+05:30`,
      to:   `${day}T23:59:59.999+05:30`,
      day,
      shift: null
    };
  }

  const shiftId = Number(shift_id);
  if (!Number.isInteger(shiftId) || shiftId <= 0) {
    throw httpError('shift_id must be a positive integer', 400);
  }

  const { rows, rowCount } = await db.query(
    `SELECT id, shift_code, start_time, end_time
     FROM shifts WHERE id = $1 AND company_id = $2`,
    [shiftId, companyId]
  );
  /* 404, not 500 — and deliberately the same message whether the shift is
     missing or belongs to another company, so this cannot be used to probe
     which shift ids exist. */
  if (rowCount === 0) throw httpError('Shift not found or access denied', 404);

  const shift = rows[0];
  const overnight = String(shift.start_time) > String(shift.end_time);

  // an overnight shift dated the 5th runs 05→06
  const endDay = overnight
    ? new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)
    : day;

  return {
    from: `${day}T${shift.start_time}+05:30`,
    to:   `${endDay}T${shift.end_time}+05:30`,
    day,
    shift
  };
}

/** WHERE fragment + params shared by the hourly rollup queries. */
function scope(companyId, win, machineId, startIdx = 1) {
  const params = [companyId, win.from, win.to];
  let sql = `company_id = $${startIdx} AND hour_start >= $${startIdx + 1} AND hour_start < $${startIdx + 2}`;
  if (machineId) {
    params.push(machineId);
    sql += ` AND machine_id = $${startIdx + 3}`;
  }
  return { sql, params };
}

module.exports = { resolveWindow, scope, parseDate, parseMachineId, httpError };
