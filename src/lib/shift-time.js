/*
 * Pure shift-time helpers. No DB / IO.
 * Handles overnight shifts (start > end) cleanly so every consumer agrees
 * on the math instead of each service rolling its own.
 */

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h = 0, m = 0] = String(timeStr).split(':').map(Number);
  return (h * 60) + m;
}

/**
 * Returns shift duration in minutes, handling overnight (start > end).
 * 08:00 → 20:00  → 720
 * 20:00 → 08:00  → 720
 */
function shiftDurationMinutes(startTime, endTime) {
  const startMin = timeToMinutes(startTime);
  const endMin   = timeToMinutes(endTime);
  return endMin > startMin
    ? endMin - startMin
    : (1440 - startMin) + endMin;
}

/**
 * Planned production minutes = duration - breaks.
 * Always >= 1 to avoid divide-by-zero downstream.
 */
function plannedMinutes(startTime, endTime, breakMinutes = 0) {
  const dur = shiftDurationMinutes(startTime, endTime);
  return Math.max(1, dur - Number(breakMinutes || 0));
}

function isOvernight(startTime, endTime) {
  return timeToMinutes(startTime) > timeToMinutes(endTime);
}

module.exports = { timeToMinutes, shiftDurationMinutes, plannedMinutes, isOvernight };
