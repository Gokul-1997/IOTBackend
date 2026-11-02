const { step, DEFAULT_RULE } = require('../../src/lib/energy-counter');

const START = Date.parse('2026-10-28T20:00:00+05:30');
const at = seconds => START + seconds * 1000;
const sample = (value, seconds, extra = {}) => ({ value, at: at(seconds), ...extra });
const replay = (observations, seed = null) => observations.reduce((result, observation) => {
  const next = step(result.state, observation);
  return { state: next.state, facts: [...result.facts, next.fact] };
}, { state: seed, facts: [] });
const sum = facts => facts.reduce((total, fact) => total + (fact.delta == null ? 0 : fact.delta), 0);

describe('cumulative energy counter', () => {
  test('uses zero as a valid initial baseline without inventing its preceding consumption', () => {
    const first = step(null, sample(0, 0));
    expect(first.fact).toMatchObject({ delta: null, quality: 'baseline', allocated: false, measured_seconds: 0 });
    expect(first.state).toMatchObject({ baseline_value: 0, baseline_at: at(0), last_at: at(0), epoch_at: at(0), uncertain: false });
    const next = step(first.state, sample(0.5, 30));
    expect(next.fact).toMatchObject({ delta: 0.5, quality: 'measured', allocated: true, measured_seconds: 30 });
  });

  test('emits UTC ISO timestamps while persisting deterministic epoch milliseconds', () => {
    const first = step(null, { value: 100, at: '2026-10-28T20:00:00+05:30' });
    const next = step(first.state, { value: 101, at: new Date(at(30)) });
    expect(next.fact.at).toBe('2026-10-28T14:30:30.000Z');
    expect(next.fact.interval_start).toBe('2026-10-28T14:30:00.000Z');
    expect(next.state.baseline_at).toBe(at(30));
  });

  test('quarantines a decreasing counter, and only counts beyond the held high-water mark', () => {
    const result = replay([sample(100, 0), sample(90, 10), sample(100, 20), sample(101, 30)]);
    expect(result.facts.map(fact => fact.quality)).toEqual(['baseline', 'regression', 'recovered', 'measured']);
    expect(result.facts.map(fact => fact.delta)).toEqual([null, null, 0, 1]);
    expect(sum(result.facts)).toBe(1);
    expect(result.facts[1]).toMatchObject({ allocated: false, measured_seconds: 0 });
    // Recovery updates the current state; the original uncertain fact survives.
    expect(result.state.uncertain).toBe(false);
    expect(result.facts[1].quality).toBe('regression');
  });

  test('holds the baseline during repeated zero drops and oscillating telemetry', () => {
    const result = replay([100, 0, 100, 90, 100, 90, 101].map((value, index) => sample(value, index * 5)));
    expect(sum(result.facts)).toBe(1);
    expect(result.facts.filter(fact => fact.quality === 'regression')).toHaveLength(3);
  });

  test('rejects an implausible spike without poisoning the next valid reading', () => {
    const first = step(null, sample(100, 0));
    const spike = step(first.state, sample(1e15, 10));
    expect(spike.fact).toMatchObject({ quality: 'spike', delta: null, allocated: false });
    expect(spike.state).toMatchObject({ baseline_value: 100, baseline_at: at(0), uncertain: true, last_at: at(10) });
    const recovered = step(spike.state, sample(101, 20));
    expect(recovered.fact).toMatchObject({ quality: 'recovered', delta: 1 });
  });

  test('bounds increases by elapsed time plus one configured resolution increment', () => {
    const rule = { max_rate_units_per_hour: 360, resolution: 0.01 };
    const first = step(null, sample(100, 0, { rule }));
    expect(step(first.state, sample(101.01, 10)).fact.delta).toBeCloseTo(1.01);
    expect(step(first.state, sample(101.0101, 10)).fact).toMatchObject({ delta: null, quality: 'spike' });
  });

  test('accepts a known long-gap increase but never assigns it to a fabricated measured interval', () => {
    const result = replay([sample(100, 0), sample(150, 3600), sample(151, 3630)]);
    expect(result.facts[1]).toMatchObject({ quality: 'gap', delta: 50, allocated: false, measured_seconds: 0 });
    expect(result.facts[2]).toMatchObject({ quality: 'measured', delta: 1, allocated: true, measured_seconds: 30 });
    expect(sum(result.facts)).toBe(51);
  });

  test('does not infer a rollover from an unexplained decrease', () => {
    const first = step(null, sample(98, 0));
    const next = step(first.state, sample(2, 30));
    expect(next.fact).toMatchObject({ delta: null, quality: 'regression' });
    expect(next.state.baseline_value).toBe(98);
  });

  test('accepts an explicitly configured plausible wrap near both ends of the modulus', () => {
    const first = step(null, sample(98, 0, { rule: { rollover_value: 100 } }));
    const next = step(first.state, sample(2, 30));
    expect(next.fact).toMatchObject({ delta: 4, quality: 'rollover', allocated: true, measured_seconds: 30 });
    expect(next.state).toMatchObject({ baseline_value: 2, epoch_at: at(30) });
    expect(step(next.state, sample(3, 40)).fact.delta).toBe(1);
  });

  test.each([[50, 2], [98, 30]])('a configured modulus cannot turn %s -> %s into a guessed wrap', (before, after) => {
    const first = step(null, sample(before, 0, { rule: { rollover_value: 100 } }));
    expect(step(first.state, sample(after, 30)).fact).toMatchObject({ delta: null, quality: 'regression' });
  });

  test('a near-edge wrap must also pass the configured maximum rate', () => {
    const first = step(null, sample(900, 0, { rule: { rollover_value: 1000, max_rate_units_per_hour: 1, resolution: 0 } }));
    const next = step(first.state, sample(100, 30));
    expect(next.fact).toMatchObject({ delta: null, quality: 'spike' });
    expect(next.state.baseline_value).toBe(900);
  });

  test('declared reset accounts from its verified baseline and applies the event exactly once', () => {
    const event = { id: 'reset-1', type: 'reset', effective_at: at(1200), baseline_value: 0 };
    const result = replay([
      sample(500, 0), sample(520, 600), sample(3, 1230, { event }), sample(5, 1260, { event }),
    ]);
    expect(result.facts.map(fact => fact.delta)).toEqual([null, 20, 3, 2]);
    expect(result.facts[2]).toMatchObject({ quality: 'reset', interval_start: new Date(at(1200)).toISOString() });
    expect(result.facts[3].quality).toBe('measured');
    expect(result.state).toMatchObject({ epoch_at: at(1200), event_at: at(1200), event_id: 'reset-1' });
    expect(sum(result.facts)).toBe(25);
  });

  test('replacement without a verified baseline starts a new epoch with unknown initial usage', () => {
    const first = step(null, sample(500, 0));
    const replaced = step(first.state, sample(3, 60, {
      event: { type: 'replacement', id: 2, effective_at: at(40) },
    }));
    expect(replaced.fact).toMatchObject({ quality: 'reset', delta: null, allocated: false, interval_start: null });
    expect(replaced.state).toMatchObject({ baseline_value: 3, baseline_at: at(60), epoch_at: at(40), uncertain: false });
    expect(step(replaced.state, sample(5, 90)).fact.delta).toBe(2);
  });

  test('can start replay from a declared verified event before the first observation', () => {
    const result = step(null, sample(3, 30, {
      event: { kind: 'reset', id: 'verified', effective_at: at(0), baseline_value: 0 },
    }));
    expect(result.fact).toMatchObject({ quality: 'reset', delta: 3, allocated: true, measured_seconds: 30 });
  });

  test('does not apply a future event early', () => {
    const event = { type: 'reset', id: 3, effective_at: at(100), baseline_value: 0 };
    const first = step(null, sample(100, 0));
    const future = step(first.state, sample(101, 30, { event }));
    expect(future.fact).toMatchObject({ quality: 'measured', delta: 1 });
    expect(future.state.event_id).toBeNull();
    expect(step(future.state, sample(1, 110, { event })).fact).toMatchObject({ quality: 'reset', delta: 1 });
  });

  test('rejects a newly discovered historical reset until the caller replays before its effective instant', () => {
    const first = step(null, sample(100, 0));
    const event = { type: 'reset', id: 4, effective_at: at(-10), baseline_value: 0 };
    const invalid = step(first.state, sample(2, 20, { event }));
    expect(invalid.fact.quality).toBe('invalid');
    expect(invalid.state).toEqual(first.state);
  });

  test('changing a rate configuration retains valid energy instead of resetting the counter', () => {
    const first = step(null, sample(100, 0, { rule: { rule_id: 'old' } }));
    const next = step(first.state, sample(101, 30, {
      rule: { rule_id: 'new', max_rate_units_per_hour: 3000, effective_from: at(20) },
    }));
    expect(next.fact).toMatchObject({ quality: 'config_change', delta: 1, allocated: true, rule_id: 'new' });
    expect(next.state).toMatchObject({ baseline_value: 101, epoch_at: at(0), rule_id: 'new' });
  });

  test('keeps the old rule until the next rule becomes effective', () => {
    const first = step(null, sample(100, 0, { rule: { rule_id: 'old', max_rate_units_per_hour: 360 } }));
    const rule = { rule_id: 'future', max_rate_units_per_hour: 0, resolution: 0, effective_from: at(60) };
    const before = step(first.state, sample(101, 30, { rule }));
    expect(before.fact).toMatchObject({ quality: 'measured', delta: 1, rule_id: 'old' });
    const after = step(before.state, sample(102, 60, { rule }));
    expect(after.fact).toMatchObject({ quality: 'spike', delta: null, rule_id: 'future' });
    expect(after.state.baseline_value).toBe(101);
  });

  test('persists custom rules across omitted inputs and JSON serialization', () => {
    const first = step(null, sample(100, 0, { rule: { resolution: 0, max_rate_units_per_hour: 1, rule_id: 9 } }));
    const next = step(JSON.parse(JSON.stringify(first.state)), sample(101, 30));
    expect(next.fact).toMatchObject({ quality: 'spike', delta: null, rule_id: 9 });
  });

  test('supports restoring the documented minimum checkpoint before optional metadata was persisted', () => {
    const seed = { baseline_value: 100, baseline_at: at(0), last_at: at(0), uncertain: false, epoch_at: at(0), rule_id: 7 };
    expect(step(seed, sample(101, 30)).fact).toMatchObject({ quality: 'measured', delta: 1, rule_id: 7, event_id: null });
  });

  test('a checkpoint with string timestamps cannot create NaN measured intervals', () => {
    const first = step(null, sample(100, 0));
    const corrupt = { ...first.state, baseline_at: new Date(at(0)).toISOString() };
    const invalid = step(corrupt, sample(101, 30));
    expect(invalid.fact).toMatchObject({ quality: 'invalid', delta: null, allocated: false, measured_seconds: 0 });
  });

  test('replaying sorted late readings from the preceding state is deterministic', () => {
    const observations = [sample(100, 0), sample(101, 30), sample(101.2, 45), sample(102, 60)];
    const full = replay(observations);
    const seed = replay(observations.slice(0, 2));
    const tail = replay(observations.slice(2), JSON.parse(JSON.stringify(seed.state)));
    expect(tail.state).toEqual(full.state);
    expect(tail.facts).toEqual(full.facts.slice(2));
    expect(sum(full.facts)).toBe(2);
  });

  test.each([NaN, Infinity, -Infinity, -1, null, undefined, '100', true, {}, []])('rejects non-counter input %p', value => {
    const first = step(null, sample(100, 0));
    const invalid = step(first.state, sample(value, 30));
    expect(invalid.fact).toMatchObject({ quality: 'invalid', delta: null, allocated: false, measured_seconds: 0 });
    expect(invalid.state).toEqual(first.state);
  });

  test.each(['2026-10-28T20:00:00', 'not-a-date', new Date(NaN), Infinity])('rejects invalid or timezone-ambiguous timestamp %p', time => {
    expect(step(null, { value: 100, at: time }).fact).toMatchObject({ at: null, quality: 'invalid', delta: null });
  });

  test('duplicate or out-of-order observations cannot count twice or mutate the checkpoint', () => {
    const first = step(null, sample(100, 0));
    const next = step(first.state, sample(101, 30));
    for (const observation of [sample(101, 30), sample(100.5, 20)]) {
      const repeated = step(next.state, observation);
      expect(repeated.fact).toMatchObject({ quality: 'invalid', delta: null, allocated: false });
      expect(repeated.state).toEqual(next.state);
    }
  });

  test.each([
    { max_rate_units_per_hour: -1 }, { resolution: '1' }, { max_gap_seconds: NaN },
    { rollover_value: 0 }, { rollover_margin_ratio: 0.6 }, { effective_from: '2026-10-28 20:00' },
    { rule_id: Infinity },
  ])('invalid configuration fails closed: %p', rule => {
    const first = step(null, sample(100, 0));
    const invalid = step(first.state, sample(101, 30, { rule }));
    expect(invalid.fact).toMatchObject({ quality: 'invalid', delta: null });
    expect(invalid.state).toEqual(first.state);
  });

  test('does not mutate the previous checkpoint, rule, or observation', () => {
    const first = step(null, sample(100, 0));
    Object.freeze(first.state.rule);
    Object.freeze(first.state);
    const rule = Object.freeze({ rule_id: 2, max_gap_seconds: 30 });
    const observation = Object.freeze(sample(101, 30, { rule }));
    expect(step(first.state, observation).fact.delta).toBe(1);
    expect(first.state.baseline_value).toBe(100);
    expect(rule).toEqual({ rule_id: 2, max_gap_seconds: 30 });
    expect(DEFAULT_RULE.max_gap_seconds).toBe(60);
  });
});
