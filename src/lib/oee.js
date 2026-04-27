/*
 * Pure OEE calculation. No DB / IO. Used by:
 *   - shiftOee.job (cron rollup)
 *   - dashboard.service (live in-progress shift fallback)
 * Single source of truth for the formula → consistent everywhere.
 */

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function pct(n) {
  return Number(clamp(n, 0, 100).toFixed(2));
}

/**
 * @param {object} input
 * @param {number} input.runSeconds       Total run seconds during shift window
 * @param {number} input.plannedSeconds   Shift planned production seconds (duration - breaks)
 * @param {number} input.producedQty      Total produced parts (after multiplication factor)
 * @param {number} input.cycleSeconds     Component cycle time in seconds (0 if unknown)
 * @param {number} input.rejectQty        Quality rejects
 * @param {number} input.reworkQty        Quality reworks
 * @returns {{availability:number, performance:number, quality:number, oee:number}}
 */
function computeOEE({
  runSeconds = 0,
  plannedSeconds = 0,
  producedQty = 0,
  cycleSeconds = 0,
  rejectQty = 0,
  reworkQty = 0
} = {}) {
  const run      = Number(runSeconds)    || 0;
  const planned  = Number(plannedSeconds) || 0;
  const produced = Number(producedQty)   || 0;
  const cycle    = Number(cycleSeconds)  || 0;
  const reject   = Number(rejectQty)     || 0;
  const rework   = Number(reworkQty)     || 0;

  const accepted = Math.max(0, produced - reject - rework);

  const availability = planned > 0 ? (run / planned) * 100 : 0;
  const idealQty     = cycle > 0 ? run / cycle : 0;
  const performance  = idealQty > 0 ? (produced / idealQty) * 100 : 0;
  const quality      = produced > 0 ? (accepted / produced) * 100 : 0;
  const oee          =
    (clamp(availability, 0, 100) / 100) *
    (clamp(performance,  0, 100) / 100) *
    (clamp(quality,      0, 100) / 100) *
    100;

  return {
    availability: pct(availability),
    performance:  pct(performance),
    quality:      pct(quality),
    oee:          pct(oee)
  };
}

module.exports = { computeOEE };
