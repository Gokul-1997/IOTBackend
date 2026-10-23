/*
 * Energy per machine per hour, kept (dashboard/energy-hourly.service.js).
 *
 * The rule must be the Energy screen's, byte for byte where it matters
 * (only real readings; a fall or a misread counts nothing), with one thing
 * the screen's range query cannot do: compare each stretch's first reading
 * with the one before it, or an interval would be lost at every hour the
 * job stops at. The kept hours must stay one unbroken stretch, and two
 * processes must never fill the same company at once.
 */
jest.mock('../../src/db', () => require('../helpers/mockDb').mockDb);
const { mockDb, resetDb } = require('../helpers/mockDb');
const hourly = require('../../src/dashboard/energy-hourly.service');

const H = hourly.HOUR_MS;
const at = iso => Date.parse(iso);
const executable = sql => String(sql).replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => resetDb());

describe('the hours follow the plant clock', () => {
  test('an hour starts on the IST hour (UTC :30)', () => {
    expect(new Date(hourly.istHour(at('2026-10-23T05:10:00Z'))).toISOString()).toBe('2026-10-23T04:30:00.000Z');   // 10:40 IST → 10:00 IST
  });

  test('an hour is kept only once it is 15 minutes over', () => {
    // 10:10 IST: the 09:00 hour ends at 10:00 but is not final until 10:15
    expect(new Date(hourly.settledUntil(at('2026-10-23T04:40:00Z'))).toISOString()).toBe('2026-10-23T03:30:00.000Z');
    // 10:20 IST: it is
    expect(new Date(hourly.settledUntil(at('2026-10-23T04:50:00Z'))).toISOString()).toBe('2026-10-23T04:30:00.000Z');
  });
});

describe('the Energy screen\'s rule, with no interval lost between stretches', () => {
  const sql = executable(hourly.HOURS_SQL);

  test('only real readings, a fall counts nothing, a misread counts nothing', () => {
    expect(sql).toMatch(/AND t\.energy > 0/);
    expect(sql).toMatch(/WHEN energy <= prev_energy THEN 0/);
    expect(sql).toMatch(/energy - prev_energy\s+> 2000 \* GREATEST\(EXTRACT\(EPOCH FROM received_at - prev_at\), 300\) \/ 3600\.0 THEN 0/);
    expect(sql).not.toMatch(/MAX\(energy\)\s*-\s*MIN\(energy\)/);
  });

  test('each machine\'s first reading is compared with its last one before the stretch', () => {
    expect(sql).toMatch(/CROSS JOIN LATERAL/);
    expect(sql).toMatch(/t\.received_at <\s+\$2::timestamptz\s+AND t\.received_at >= \$2::timestamptz - INTERVAL '2 days'/);
    expect(sql).toMatch(/ORDER BY t\.received_at DESC\s+LIMIT 1/);
    // the earlier reading is only the baseline: its own rise belongs to the stretch before
    expect(sql).toMatch(/WHERE prev_energy IS NOT NULL\s+AND received_at >= \$2::timestamptz/);
  });

  test('each rise goes to the IST hour of the later reading', () => {
    expect(sql).toMatch(/date_trunc\('hour', received_at AT TIME ZONE 'Asia\/Kolkata'\) AT TIME ZONE 'Asia\/Kolkata' AS hour_start/);
  });
});

describe('keeping a stretch of hours', () => {
  const from = at('2026-10-23T03:30:00Z'), to = at('2026-10-23T04:30:00Z');

  test('worked out, the old rows replaced, the coverage widened, all in one transaction', async () => {
    mockDb.queueResponse(
      { rows: [] },                                                               // BEGIN
      { rows: [{ from_hour: '2026-10-20T18:30:00Z', to_hour: '2026-10-23T03:30:00Z' }] },   // coverage
      { rows: [{ machine_id: 7, hour_start: new Date(from), kwh: 12.5, readings: 240 }] },  // the hours
      { rows: [] },                                                               // DELETE
      { rows: [] },                                                               // INSERT
      { rows: [{ from_hour: '2026-10-20T18:30:00Z', to_hour: '2026-10-23T04:30:00Z' }] },   // coverage after
      { rows: [] });                                                              // COMMIT
    const cov = await hourly.fillChunk(4, from, to);
    expect(cov).toEqual({ from: at('2026-10-20T18:30:00Z'), to });
    const sqls = mockDb.calls().map(c => c.text);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(sqls.findIndex(s => /DELETE FROM energy_hourly/.test(s))).toBeLessThan(sqls.findIndex(s => /INSERT INTO energy_hourly /.test(s)));
    const insert = mockDb.calls().find(c => /INSERT INTO energy_hourly /.test(c.text));
    expect(insert.params[0]).toBe(4);
    expect(insert.params[1]).toEqual([7]);
    expect(insert.params[3]).toEqual([12.5]);
    expect(mockDb.calls().find(c => /energy_hourly_coverage \(company_id/.test(c.text)).text).toMatch(/LEAST[\s\S]*GREATEST/);
  });

  test('another process filling the same company: nothing is worked out twice', async () => {
    mockDb.denyAdvisoryLock();
    expect(await hourly.fillChunk(4, from, to)).toBeNull();
    const sqls = mockDb.calls().map(c => c.text);
    expect(sqls).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('a stretch that would leave a hole is not kept', async () => {
    mockDb.queueResponse({ rows: [] },
      { rows: [{ from_hour: '2026-10-20T18:30:00Z', to_hour: '2026-10-21T18:30:00Z' }] });
    const cov = await hourly.fillChunk(4, from, to);
    expect(cov).toEqual({ from: at('2026-10-20T18:30:00Z'), to: at('2026-10-21T18:30:00Z') });
    expect(mockDb.calls().map(c => c.text)).not.toContainEqual(expect.stringMatching(/DELETE|INSERT/));
  });
});

describe('reading the hours', () => {
  const now = at('2026-10-23T05:00:00Z');                    // 10:30 IST

  test('kept hours, then the ones not kept yet worked out from the readings', async () => {
    mockDb.queueResponse(
      { rows: [{ from_hour: '2026-09-01T18:30:00Z', to_hour: '2026-10-23T03:30:00Z' }] },
      { rows: [{ machine_id: 7, hour_start: '2026-10-22T03:30:00Z', kwh: 10, readings: 200 }] },
      { rows: [{ machine_id: 7, hour_start: '2026-10-23T04:30:00Z', kwh: 5, readings: 100 }] });
    const r = await hourly.hours(4, at('2026-10-01T18:30:00Z'), now);
    expect(r.completeFrom).toBe(at('2026-10-01T18:30:00Z'));
    expect(r.rows.map(x => x.kwh)).toEqual([10, 5]);
    const [, kept, tail] = mockDb.calls();
    expect(kept.params.slice(1).map(d => d.toISOString())).toEqual(['2026-10-01T18:30:00.000Z', '2026-10-23T03:30:00.000Z']);
    expect(tail.params[1].toISOString()).toBe('2026-10-23T03:30:00.000Z');
  });

  test('history not worked out that far back yet: the answer says from when it is whole', async () => {
    mockDb.queueResponse({ rows: [{ from_hour: '2026-10-15T18:30:00Z', to_hour: '2026-10-23T03:30:00Z' }] });
    const r = await hourly.hours(4, at('2026-10-01T18:30:00Z'), now);
    expect(r.completeFrom).toBe(at('2026-10-15T18:30:00Z'));
  });

  test('nothing kept (or the job far behind): at most two days are worked out on the spot', async () => {
    mockDb.queueResponse({ rows: [] });
    const r = await hourly.hours(4, at('2026-10-01T18:30:00Z'), now);
    expect(r.completeFrom).toBe(hourly.istHour(now - 48 * H));
    expect(mockDb.calls()).toHaveLength(2);                   // the coverage, then the readings
  });
});

describe('bringing a company up to date', () => {
  const now = at('2026-10-23T05:00:00Z');

  test('from nothing: the last day first, then back a week at a time until the deadline', async () => {
    const chunks = [];
    const original = mockDb.query.getMockImplementation();
    let cov = null;
    mockDb.query.mockImplementation(async (text, params) => {
      const sql = typeof text === 'string' ? text : text.text;
      if (/FROM energy_hourly_coverage WHERE/.test(sql)) return { rows: cov ? [{ from_hour: new Date(cov.from), to_hour: new Date(cov.to) }] : [] };
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/INSERT INTO energy_hourly_coverage/.test(sql)) {
        const [, f, t] = params;
        cov = cov ? { from: Math.min(cov.from, +f), to: Math.max(cov.to, +t) } : { from: +f, to: +t };
        chunks.push([+f, +t]);
        return { rows: [{ from_hour: new Date(cov.from), to_hour: new Date(cov.to) }] };
      }
      return { rows: [] };
    });
    const result = await hourly.extend(4, { now, historyDays: 15, deadline: Date.now() + 10_000 });
    const until = hourly.settledUntil(now);
    expect(chunks[0]).toEqual([until - 24 * H, until]);
    expect(chunks[1]).toEqual([until - 8 * 24 * H, until - 24 * H]);
    expect(result).toEqual({ from: hourly.istHour(now - 15 * 24 * H), to: until });
    mockDb.query.mockImplementation(original);
  });
});
