'use strict';

/**
 * Conservative cumulative-counter accounting. Values must already use the same
 * canonical unit (normally kWh); this module never infers a unit or a reset.
 *
 * step(state, { value, at, rule?, event? }) -> { state, fact }
 *
 * State is JSON-serializable. All state timestamps are epoch milliseconds;
 * fact timestamps are ISO UTC strings. `at` accepts a Date, epoch milliseconds,
 * or an ISO timestamp with an explicit time zone. The caller sorts observations
 * and seeds replay with the state immediately before its replay window.
 *
 * A fact's non-null delta is the trusted increase since interval_start. Only
 * facts with allocated=true may be attributed to an hourly/shift bucket. Long
 * gaps retain their known cumulative increase but have zero measured_seconds;
 * distributing that increase over missing hours would invent measurements.
 * State.uncertain describes a held baseline, not the quality of prior facts.
 * Recovery never rewrites or removes a prior regression/spike/gap fact.
 *
 * rule.rollover_value is the counter modulus: 98 -> 2 with modulus 100 is 4.
 * A wrap needs explicit configuration, readings near both ends, and a plausible
 * increase. Explicit reset/replacement events have an id and effective_at. A
 * verified baseline_value permits accounting from that instant. Without it,
 * the first reading establishes a baseline and its preceding usage is unknown.
 */

const DEFAULT_RULE = Object.freeze({
  max_rate_units_per_hour: 2000,
  resolution: 1,
  max_gap_seconds: 60,
  rollover_value: null,
  rollover_margin_ratio: 0.1,
  rule_id: null,
  effective_from: null,
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const counter = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = value => (typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isFinite(value));
const iso = at => at == null ? null : new Date(at).toISOString();

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
  }
  // Bare local times depend on the server's timezone and are not safe inputs.
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRule(input, previous) {
  const merged = { ...DEFAULT_RULE, ...previous, ...input };
  const positive = key => typeof merged[key] === 'number' && Number.isFinite(merged[key]);
  if (!positive('max_rate_units_per_hour') || merged.max_rate_units_per_hour < 0
      || !positive('resolution') || merged.resolution < 0
      || !positive('max_gap_seconds') || merged.max_gap_seconds < 0
      || !positive('rollover_margin_ratio') || merged.rollover_margin_ratio < 0
      || merged.rollover_margin_ratio > 0.5
      || (merged.rollover_value != null && (!counter(merged.rollover_value) || merged.rollover_value === 0))) {
    return null;
  }
  if (merged.rule_id != null && !identifier(merged.rule_id)) return null;
  const effective = merged.effective_from == null ? null : timestamp(merged.effective_from);
  if (merged.effective_from != null && effective == null) return null;
  return {
    max_rate_units_per_hour: merged.max_rate_units_per_hour,
    resolution: merged.resolution,
    max_gap_seconds: merged.max_gap_seconds,
    rollover_value: merged.rollover_value,
    rollover_margin_ratio: merged.rollover_margin_ratio,
    rule_id: merged.rule_id,
    effective_from: effective,
  };
}

function sameRule(a, b) {
  return ['max_rate_units_per_hour', 'resolution', 'max_gap_seconds',
    'rollover_value', 'rollover_margin_ratio'].every(key => a[key] === b[key])
    && String(a.rule_id) === String(b.rule_id);
}

function emptyState() {
  return {
    baseline_value: null,
    baseline_at: null,
    last_at: null,
    uncertain: false,
    epoch_at: null,
    rule_id: null,
    rule: { ...DEFAULT_RULE },
    event_id: null,
    event_at: null,
  };
}

function validState(state) {
  if (state.baseline_value == null) {
    return state.baseline_at == null && state.epoch_at == null;
  }
  const storedTime = value => typeof value === 'number' && timestamp(value) != null;
  return counter(state.baseline_value)
    && storedTime(state.baseline_at)
    && storedTime(state.epoch_at)
    && storedTime(state.last_at)
    && state.last_at >= state.baseline_at;
}

function step(previousState, observation) {
  const previous = { ...emptyState(), ...previousState };
  // Restoring the documented minimum checkpoint is supported even when an old
  // caller has not persisted the optional rule snapshot/event fields yet.
  if (previousState != null && !previousState.rule) {
    previous.rule = { ...DEFAULT_RULE, rule_id: previous.rule_id };
  }
  const input = observation && typeof observation === 'object' ? observation : {};
  const at = timestamp(input.at);
  const value = input.value;
  const stateRule = normalizeRule(previous.rule || {}, { ...DEFAULT_RULE, rule_id: previous.rule_id });
  const fact = {
    at: iso(at),
    value: counter(value) ? value : null,
    interval_start: null,
    delta: null,
    quality: 'invalid',
    allocated: false,
    measured_seconds: 0,
    rule_id: previous.rule_id == null ? null : previous.rule_id,
    epoch_at: previous.epoch_at == null || timestamp(previous.epoch_at) == null
      ? null : iso(timestamp(previous.epoch_at)),
    event_id: previous.event_id == null ? null : previous.event_id,
  };
  const unchanged = () => ({ state: { ...previous, rule: previous.rule ? { ...previous.rule } : { ...DEFAULT_RULE } }, fact });

  if (at == null || !counter(value) || !validState(previous) || !stateRule
      || (previous.last_at != null && at <= previous.last_at)) return unchanged();

  let rule = stateRule;
  if (input.rule != null) {
    if (typeof input.rule !== 'object' || Array.isArray(input.rule)) return unchanged();
    const candidate = normalizeRule(input.rule, stateRule);
    if (!candidate) return unchanged();
    if (candidate.effective_from == null || candidate.effective_from <= at) rule = candidate;
  }
  const state = { ...previous, rule: { ...rule }, rule_id: rule.rule_id, last_at: at };
  fact.rule_id = state.rule_id;
  const ruleChanged = !sameRule(stateRule, rule);
  let eventApplied = false;
  let unknownEventBaseline = false;

  if (input.event != null) {
    const event = input.event;
    const kind = event && (event.type || event.kind);
    const eventAt = event && timestamp(event.effective_at);
    const hasBaseline = event && own(event, 'baseline_value') && event.baseline_value != null;
    if (!event || !['reset', 'replacement'].includes(kind)
        || !identifier(event.id)
        || eventAt == null || (hasBaseline && !counter(event.baseline_value))) return unchanged();
    const alreadyApplied = String(event.id) === String(previous.event_id)
      || (previous.event_at != null && eventAt <= previous.event_at);
    if (eventAt <= at && !alreadyApplied) {
      // An event predating the state requires replay from before that event;
      // applying it now would count an already-accounted interval twice.
      if (previous.last_at != null && eventAt < previous.last_at) return unchanged();
      eventApplied = true;
      unknownEventBaseline = !hasBaseline;
      state.baseline_value = hasBaseline ? event.baseline_value : value;
      state.baseline_at = hasBaseline ? eventAt : at;
      state.epoch_at = eventAt;
      state.event_id = event.id;
      state.event_at = eventAt;
      state.uncertain = false;
    }
  }

  if (state.baseline_value == null || unknownEventBaseline) {
    state.baseline_value = value;
    state.baseline_at = at;
    state.epoch_at = state.epoch_at == null ? at : state.epoch_at;
    state.uncertain = false;
    fact.quality = eventApplied ? 'reset' : 'baseline';
    fact.epoch_at = iso(state.epoch_at);
    fact.event_id = state.event_id;
    return { state, fact };
  }

  const seconds = (at - state.baseline_at) / 1000;
  const previousBaseline = state.baseline_value;
  let delta = value - previousBaseline;
  let rollover = false;
  fact.interval_start = iso(state.baseline_at);
  fact.epoch_at = iso(state.epoch_at);
  fact.event_id = state.event_id;

  if (delta < 0) {
    const modulus = rule.rollover_value;
    const margin = rule.rollover_margin_ratio;
    if (modulus != null && previousBaseline <= modulus
        && previousBaseline >= modulus * (1 - margin) && value <= modulus * margin) {
      delta = modulus - previousBaseline + value;
      rollover = true;
    } else {
      state.uncertain = true;
      fact.quality = 'regression';
      return { state, fact };
    }
  }

  const maxIncrease = rule.resolution + rule.max_rate_units_per_hour * seconds / 3600;
  // Tolerance only absorbs floating-point arithmetic, not an extra meter unit.
  const epsilon = Math.max(1, value, previousBaseline, Math.abs(maxIncrease)) * Number.EPSILON * 8;
  if (!Number.isFinite(delta) || seconds < 0 || delta > maxIncrease + epsilon) {
    state.uncertain = true;
    fact.quality = 'spike';
    return { state, fact };
  }

  fact.delta = delta === 0 ? 0 : delta;
  const gap = seconds > rule.max_gap_seconds;
  fact.allocated = seconds > 0 && !gap;
  fact.measured_seconds = fact.allocated ? seconds : 0;
  fact.quality = gap ? 'gap'
    : rollover ? 'rollover'
      : eventApplied ? 'reset'
        : ruleChanged ? 'config_change'
          : previous.uncertain ? 'recovered'
            : delta === 0 ? 'flat' : 'measured';
  state.baseline_value = value;
  state.baseline_at = at;
  state.uncertain = false;
  if (rollover) state.epoch_at = at;
  fact.epoch_at = iso(state.epoch_at);
  return { state, fact };
}

module.exports = { step, DEFAULT_RULE };
