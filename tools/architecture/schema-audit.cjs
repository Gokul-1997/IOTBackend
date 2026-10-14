/* Read-only schema evidence, never reads .env or samples customer records.
 * SCHEMA_AUDIT_URL=<private connection URL> node tools/architecture/schema-audit.cjs
 * Redirect stdout to a private audit artifact. Credentials are never printed.
 */
const { Pool } = require('pg');
async function main() {
  if (!process.env.SCHEMA_AUDIT_URL) throw new Error('Set SCHEMA_AUDIT_URL explicitly; no application environment is loaded.');
  const pool = new Pool({ connectionString: process.env.SCHEMA_AUDIT_URL, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'iot-readonly-schema-audit' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const queries = {
      versions: "SELECT current_setting('server_version') AS postgres, extname, extversion FROM pg_extension WHERE extname IN ('timescaledb','pgcrypto') ORDER BY extname",
      tables: "SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') ORDER BY c.relname",
      columns: "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      constraints: "SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,k.convalidated AS validated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname",
      indexes: "SELECT s.relname AS table_name,s.indexrelname AS name,s.idx_scan,pg_relation_size(s.indexrelid)::text AS bytes,pg_get_indexdef(s.indexrelid) AS definition FROM pg_stat_user_indexes s WHERE s.schemaname='public' ORDER BY s.relname,s.indexrelname",
      policies: "SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname"
    };
    const result = { captured_at: new Date().toISOString(), access: 'READ ONLY; no customer row samples', evidence: {} };
    for (const [key, sql] of Object.entries(queries)) result.evidence[key] = (await client.query(sql)).rows;
    const timescale = result.evidence.versions.some(row => row.extname === 'timescaledb');
    if (timescale) {
      result.evidence.hypertables = (await client.query('SELECT * FROM timescaledb_information.hypertables')).rows;
      result.evidence.jobs = (await client.query('SELECT job_id,application_name,proc_name,hypertable_schema,hypertable_name,config FROM timescaledb_information.jobs')).rows;
    }
    await client.query('COMMIT');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error('Schema audit failed:', error.code || error.message); process.exitCode = 1; });
