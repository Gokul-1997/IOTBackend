const { computeOEE } = require('../../src/lib/oee');

describe('computeOEE', () => {
  test('returns zeros when nothing is produced', () => {
    const r = computeOEE({});
    expect(r).toEqual({ availability: 0, performance: 0, quality: 0, oee: 0 });
  });

  test('availability = run / planned * 100', () => {
    const r = computeOEE({ runSeconds: 21600, plannedSeconds: 43200 });
    expect(r.availability).toBe(50);
  });

  test('availability is capped at 100% when run > planned (sensor overcount)', () => {
    const r = computeOEE({ runSeconds: 50000, plannedSeconds: 43200 });
    expect(r.availability).toBe(100);
  });

  test('performance compares actual produced vs ideal at cycle time', () => {
    // 1 hr run, 30 sec cycle → ideal = 120 parts. produced 60 → performance 50%
    const r = computeOEE({
      runSeconds:    3600,
      plannedSeconds: 3600,
      producedQty:    60,
      cycleSeconds:   30
    });
    expect(r.performance).toBe(50);
  });

  test('quality = (produced - reject - rework) / produced * 100', () => {
    const r = computeOEE({
      runSeconds:    3600,
      plannedSeconds: 3600,
      producedQty:    100,
      cycleSeconds:   36,
      rejectQty:      5,
      reworkQty:      5
    });
    expect(r.quality).toBe(90);
  });

  test('oee = availability × performance × quality (each as fraction)', () => {
    // A=80%, P=75%, Q=95% → OEE = 0.8 * 0.75 * 0.95 = 0.57 = 57%
    const r = computeOEE({
      runSeconds:     2880,  // 80% of 3600
      plannedSeconds: 3600,
      producedQty:    60,    // ideal = 2880/36 = 80; perf = 60/80 = 75%
      cycleSeconds:   36,
      rejectQty:      3      // quality = (60-3)/60 = 95%
    });
    expect(r.availability).toBe(80);
    expect(r.performance).toBe(75);
    expect(r.quality).toBe(95);
    expect(r.oee).toBe(57);
  });

  test('zero cycle time ⇒ performance = 0 (avoids divide-by-zero)', () => {
    const r = computeOEE({
      runSeconds:    3600,
      plannedSeconds: 3600,
      producedQty:    100,
      cycleSeconds:   0
    });
    expect(r.performance).toBe(0);
    expect(r.oee).toBe(0);
  });

  test('reject + rework > produced ⇒ accepted clamped to 0, quality = 0', () => {
    const r = computeOEE({
      runSeconds:     3600,
      plannedSeconds: 3600,
      producedQty:    10,
      cycleSeconds:   360,
      rejectQty:      8,
      reworkQty:      8
    });
    expect(r.quality).toBe(0);
  });
});
