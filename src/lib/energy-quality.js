/* Broad corruption guards for a CNC's low-voltage energy meter. These are
 * admission bounds, not operating/overload alarm thresholds. Canonical energy
 * remains kWh; the UI calls one kWh one Unit. Signed active/reactive power is
 * valid. Missing and rejected measurements stay null, never clamped to zero.
 * Keep in step with pms-backend/src/lib/energy-quality.cjs (contract version 1).
 */
const ALIASES = { energy: 'kwh_total', voltage: 'v_ll_avg', current: 'i_avg', power: 'kw_total' };
function bounds(field) {
  const key = ALIASES[field] || field;
  if (/^v(?:\d|_ln|_ll)/.test(key)) return [0, 2000];
  if (/^i(?:\d|_avg)/.test(key)) return [0, 10000];
  if (/^(kw|kvar)(?:\d|_)/.test(key)) return [-2000, 2000];
  if (/^kva(?:\d|_)/.test(key)) return [0, 2000];
  if (/^pf(?:\d|_)/.test(key)) return [-1, 1];
  if (/^(kwh|kvarh|kvah)_/.test(key)) return [0, 1e12];
  if (key === 'frequency_hz') return [0, 100];
  if (/^thd_/.test(key)) return [0, 10000];
  if (key === 'run_hours') return [0, 1e6];
  if (key === 'aux_interrupts') return [0, 2147483647];
  throw new TypeError(`Unknown electrical channel: ${field}`);
}
function cleanElectrical(field, value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  const [min, max] = bounds(field);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}
function validSql(field, expression) {
  const [min, max] = bounds(field);
  return `${expression} IS NOT NULL AND ${expression} BETWEEN ${min} AND ${max}`;
}
module.exports = { bounds, cleanElectrical, validSql, VERSION: 1 };
