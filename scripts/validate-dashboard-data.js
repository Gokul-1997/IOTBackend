/* Read-only acceptance checks against actual company records. No model call,
 * migrations or data writes. Credentials are never included in the output.
 * node scripts/validate-dashboard-data.js --env-file .env --company-id 4 --date 2026-11-24
 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { sslOptions } = require('../src/config/database');

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const companyId = Number(option('--company-id'));
  const day = option('--date');
  assert(Number.isSafeInteger(companyId) && companyId > 0, '--company-id must be a positive integer');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(day || '') && new Date(day).toISOString().slice(0, 10) === day, '--date must be a calendar date');
  const envFile = option('--env-file');
  const env = envFile ? require('dotenv').parse(fs.readFileSync(envFile)) : process.env;
  const pool = new Pool({ host: env.POSTGRESQL_HOST, port: Number(env.POSTGRESQL_PORT),
    user: env.POSTGRESQL_USER, password: env.POSTGRESQL_PASSWORD, database: env.POSTGRESQL_DATABASE,
    ssl: sslOptions(env), max: 2, options: '-c default_transaction_read_only=on',
    statement_timeout: 20000, connectionTimeoutMillis: 5000, application_name: 'dashboard-acceptance-readonly' });
  // All services below share this restricted pool; do not initialize the API,
  // jobs, Redis, or its ordinary write-capable database pool.
  require.cache[require.resolve('../src/db')] = { exports: pool };
  require.cache[require.resolve('../src/dashboard/cache')] = { exports: {
    remember: (_name, _company, _params, _ttl, compute) => compute(), ttlFor: () => 0
  } };
  if (env.ENERGY_V2_ENABLED !== undefined) process.env.ENERGY_V2_ENABLED = env.ENERGY_V2_ENABLED;
  try {
    assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
    const company = (await pool.query('SELECT id, company_name FROM companies WHERE id=$1', [companyId])).rows[0];
    assert(company, 'Company not found');
    const reports = require('../src/reports/report.service');
    const alarms = require('../src/dashboard/alarm.service');
    const operators = require('../src/dashboard/operator.service');
    const validation = require('../src/assistant/assistant.validation');
    const production = await reports.productionData(companyId, day, day, null, null, null);
    const actualParts = production.rows.reduce((sum, row) => sum + Number(row.produced_qty || 0), 0);
    assert.equal(Number(production.summary.total_parts), actualParts);
    const evidence = [{ data: { report: 'Production', period: { from: day, to: day }, totals: {
      parts: actualParts, run_hours: Number(production.summary.run_hours) } } }];
    assert(validation.inspect(`${actualParts} parts`, evidence).valid);
    assert(!validation.inspect(`${actualParts + 1234567} parts`, evidence).valid);
    const alarm = await alarms.getAlarms({ company_id: companyId, from: day, to: day, part: 'kpis,charts' });
    assert.equal(alarm.pareto.reduce((sum, row) => sum + row.total, 0), Number(alarm.kpis.total));
    if (alarm.pareto.length) assert.equal(alarm.pareto.at(-1).cumulative_pct, 100);
    const operator = await operators.getOperators({ company_id: companyId, from: day, to: day });
    const machine = (await pool.query('SELECT id FROM machines WHERE company_id=$1 AND is_active ORDER BY id LIMIT 1', [companyId])).rows[0];
    const cycle = machine ? await require('../src/dashboard/cycle-time.controller').getCycleTime(machine.id, companyId, { date: day }) : null;
    assert(!cycle || cycle.points.every(point => point.cycle_seconds === null || Number.isFinite(point.cycle_seconds)));
    const fields = await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='quality_entries' AND column_name IN ('rejection_reason','rework_reason')`);
    console.log(JSON.stringify({ checked_at: new Date().toISOString(), read_only: true,
      company_id: companyId, company: company.company_name, date: day,
      production: { rows: production.rows.length, parts: actualParts, run_hours: production.summary.run_hours, summary_matches_rows: true },
      ai: { source_figure_accepted: true, fabricated_figure_rejected: true },
      alarms: { occurrences: alarm.kpis.total, pareto_buckets: alarm.pareto.length, pareto_matches_occurrences: true },
      operators: { records: operator.operators.total, estimated_production: operator.kpis.estimated_production,
        missing_cycle_machines: operator.kpis.missing_cycle_machines },
      cycle_time: cycle ? { machine_id: machine.id, hours: cycle.points.length, validated: true } : null,
      quality_reason_migration: fields.rows.length === 2 ? 'applied' : 'pending' }, null, 2));
  } finally { await pool.end(); }
}

main().catch(error => { console.error('Read-only validation failed:', error.code || error.message); process.exitCode = 1; });
