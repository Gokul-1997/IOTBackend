/*
 * The quality rule for the hourly OEE rollup.
 *
 * Stated by the plant: if parts were produced and nobody entered a quality
 * record, every part counts as good — 10 produced with no entry is 100%.
 * Quality entries record only rejects and rework, so "no entry" genuinely
 * means "nothing was rejected", not "nobody measured".
 *
 * The one case that is NOT 100% is an hour where nothing was produced.
 * There is nothing to judge, so it stays unknown; calling it 100% would let
 * idle hours inflate the plant's OEE.
 *
 * These pin the arithmetic the job performs, so a later "fix" cannot quietly
 * turn the no-entry case back into 0% — which is what the old job did, and
 * what made every stored row read quality 0 and therefore OEE 0.
 */

/** The job's own quality arithmetic, kept identical to hourlyOee.job.js. */
function quality(producedQty, reject = 0, rework = 0) {
  const accepted = Math.max(0, producedQty - reject - rework);
  return producedQty > 0 ? Math.min(100, (accepted / producedQty) * 100) : null;
}

/** The job's OEE combination: unknown in, unknown out. */
function oee(availability, performance, qual) {
  return (performance === null || qual === null)
    ? null
    : (availability / 100) * (performance / 100) * (qual / 100) * 100;
}

describe('quality when nobody entered a record', () => {
  test('10 parts produced, no quality entry, is 100%', () => {
    expect(quality(10)).toBe(100);
  });

  test('1 part produced, no entry, is still 100%', () => {
    expect(quality(1)).toBe(100);
  });

  test('a large run with no entry is 100%, not 0%', () => {
    // the old job wrote 0 here, which dragged oee to 0 for the whole plant
    expect(quality(441)).toBe(100);
  });
});

describe('quality when rejects were entered', () => {
  test('10 produced with 2 rejected is 80%', () => {
    expect(quality(10, 2)).toBe(80);
  });

  test('rework counts against quality the same as a reject', () => {
    expect(quality(10, 1, 1)).toBe(80);
  });

  test('everything rejected is 0% — a real measurement, not a missing one', () => {
    expect(quality(10, 10)).toBe(0);
  });

  test('more rejects than produced cannot push quality below zero', () => {
    // the two numbers come from different places: telemetry counts parts,
    // a person types the rejects, so they can disagree
    expect(quality(10, 50)).toBe(0);
  });
});

describe('an hour with no production', () => {
  test('is unknown, not 100%', () => {
    // calling an idle hour "100% quality" would inflate the plant's OEE
    expect(quality(0)).toBeNull();
  });

  test('is unknown even if a stray reject was entered', () => {
    expect(quality(0, 3)).toBeNull();
  });
});

describe('how quality reaches OEE', () => {
  test('a normal hour with no quality entry multiplies through at 100%', () => {
    // availability 50%, performance 80%, quality 100% -> 40%
    expect(oee(50, 80, quality(10))).toBeCloseTo(40, 5);
  });

  test('rejects reduce OEE proportionally', () => {
    expect(oee(50, 80, quality(10, 2))).toBeCloseTo(32, 5);
  });

  test('unknown quality makes OEE unknown, never 0', () => {
    expect(oee(50, 80, quality(0))).toBeNull();
  });

  test('unknown performance makes OEE unknown, even with quality at 100', () => {
    // a machine with no cycle time has no knowable performance
    expect(oee(50, null, quality(10))).toBeNull();
  });
});

describe('the job source still implements exactly this', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/cron/hourlyOee.job.js'), 'utf8');

  test('quality is null only when nothing was produced', () => {
    expect(src).toMatch(/const quality = producedQty > 0[\s\S]{0,120}: null;/);
  });

  test('accepted is produced minus reject and rework', () => {
    expect(src).toMatch(/accepted\s*=\s*Math\.max\(0,\s*producedQty\s*-\s*reject\s*-\s*rework\)/);
  });

  test('OEE is null when any factor is unknown', () => {
    expect(src).toMatch(/performance === null \|\| quality === null/);
  });

  test('the row carries company_id, so it can be filtered by company', () => {
    expect(src).toMatch(/INSERT INTO oee_hourly[\s\S]{0,120}company_id/);
  });
});
