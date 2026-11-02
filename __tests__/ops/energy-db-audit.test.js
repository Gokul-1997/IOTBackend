const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, queryInventory, explainEnergy, optionsOf, latestMeterSQL, canonicalRawSQL } = require('../../tools/architecture/energy-db-audit.cjs');
const backend = path.resolve(__dirname, '../..');

function fixture({ readOnly = true, failOptional = false } = {}) {
  const calls = [];
  const client = { query: jest.fn(async (sql, values) => {
    calls.push({ sql, values });
    if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: readOnly ? 'on' : 'off' }] };
    if (sql === 'SELECT CURRENT_TIMESTAMP AS at') return { rows: [{ at: new Date('2026-10-30T00:00:00Z') }] };
    if (failOptional && sql.includes('public.pg_stat_statements')) throw Object.assign(new Error('not installed'), { code: '42P01' });
    return { rows: [] };
  }) };
  return { client, calls };
}

test('metadata collection opens READ ONLY, never runs DDL/DML, and always rolls back', async () => {
  const f = fixture();
  const result = await collect(f.client);
  expect(result.evidence.hypertable_sizes).toBeDefined();
  expect(result.evidence.functions).toBeDefined();
  expect(f.calls[0].sql).toBe('BEGIN READ ONLY');
  expect(f.calls.at(-1).sql).toBe('ROLLBACK');
  expect(f.calls.every(({ sql }) => /^(SELECT|SHOW|SET LOCAL|BEGIN READ ONLY|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK)/.test(sql))).toBe(true);
});

test('missing optional extension is reported and isolated without hiding subsequent metadata', async () => {
  const f = fixture({ failOptional: true });
  const result = await collect(f.client);
  expect(result.evidence.statement_stats.unavailable).toBe('42P01');
  expect(result.evidence.migrations.rows).toEqual([]);
  expect(f.calls.map(c => c.sql)).toContain('ROLLBACK TO SAVEPOINT energy_audit_query');
});

test('refuses to collect if the server does not confirm a read-only transaction', async () => {
  const f = fixture({ readOnly: false });
  await expect(collect(f.client)).rejects.toThrow('Read-only transaction required');
  expect(f.calls.at(-1).sql).toBe('ROLLBACK');
  expect(f.calls.some(c => c.sql.includes('pg_constraint'))).toBe(false);
});

test.each([
  { companyId: 0, machineId: 19 },
  { companyId: 4, machineId: '19;DELETE' },
  { companyId: 4, machineId: 19, lookbackDays: 31 },
  { companyId: 4, machineId: 19, periods: [8] }
])('unbounded or invalid explain input is rejected before contacting the database: %j', async options => {
  const f = fixture();
  await expect(explainEnergy(f.client, options)).rejects.toThrow();
  expect(f.client.query).not.toHaveBeenCalled();
});

test('EXPLAIN ANALYZE executes only bounded SELECTs with explicit tenant and machine parameters', async () => {
  const f = fixture();
  await explainEnergy(f.client, { companyId: 4, machineId: 19 });
  const plans = f.calls.filter(c => c.sql.startsWith('EXPLAIN'));
  expect(plans).toHaveLength(3);
  expect(plans[0].values[0]).toBe(19);
  expect(plans[0].values[3]).toBe(4);
  expect(plans[1].values[0]).toBe(4);
  expect(plans[1].values[3]).toBe(19);
  expect(plans[2].values[2] - plans[2].values[1]).toBe(7 * 86400000);
  expect(plans.every(c => c.sql.includes('company_id') && c.sql.includes('machine_id'))).toBe(true);
  expect(f.calls.at(-1).sql).toBe('ROLLBACK');
});

test('SQL adapters extract existing pure builders without loading application database configuration', () => {
  expect(latestMeterSQL(backend)).toContain('MAX(r.read_at) FILTER');
  expect(canonicalRawSQL(backend)).toContain('AND t.machine_id=$4');
});
test('post-cutover plans include indexed projection and scoped rollup reads',async()=>{
  const f=fixture();
  const result=await explainEnergy(f.client,{companyId:4,machineId:19,v2:true});
  expect(Object.keys(result.queries)).toContain('v2_latest_projection');
  expect(Object.keys(result.queries)).toContain('v2_hourly_7d');
  const query=f.calls.find(c=>c.sql.includes('FROM energy_counter_hourly'));
  expect(query.values[0]).toBe(4);expect(query.values[3]).toBe(19);
  expect(query.sql).toContain('bucket>=$2 AND bucket<$3');
});

test('query inventory handles nested SQL templates and reports unknown dynamic calls explicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-query-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.js'), [
      'db.query(`SELECT ${columns.map(c => `r.${c}`).join(",")} FROM readings WHERE company_id=$1 AND read_at >= $2`);',
      'client.query(sql, params);'
    ].join('\n'));
    const result = queryInventory(root);
    expect(result.call_sites).toBe(2);
    expect(result.entries[0]).toMatchObject({ line: 1, dynamic: true, mentions_tenant: true, mentions_time_bound: true, relations: ['readings'] });
    expect(result.entries[1]).toMatchObject({ line: 2, dynamic: true, sql_fingerprint: null, mentions_tenant: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI requires a private absolute output and explicit EXPLAIN scope', () => {
  expect(() => optionsOf(['--out', 'audit.json'])).toThrow('absolute');
  expect(() => optionsOf(['--out', '/private/tmp/audit.json', '--explain'])).toThrow('positive');
  expect(optionsOf(['--out', '/private/tmp/audit.json'])).toMatchObject({ explain: false });
});
