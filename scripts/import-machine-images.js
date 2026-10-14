#!/usr/bin/env node
const path = require('node:path');
const importer = require('../src/files/legacy-image-import');

const HELP = `Import old machine images into private company folders.
Usage: node scripts/import-machine-images.js \\
  --source-origin https://your-old-bucket.s3.region.amazonaws.com \\
  --source-prefix /images/ [--company-id 4] [--source-dir /secure/bucket-copy] [--apply]

Default is a read-only dry run: enumerate eligible references without fetching
images or writing database/files. --apply copies and updates each image.
For a private bucket, sync its keys with the AWS CLI into --source-dir first.
Only JPEG/PNG/WebP up to 5 MB are copied; failed/oversized images keep old URLs.
Progress prints IDs and result codes only. Old source objects are never deleted.
`;

async function main(args = process.argv.slice(2)) {
  let options;
  try { options = importer.parseOptions(args); }
  catch (error) { process.stderr.write(`Configuration error: ${error.code || 'INVALID_OPTIONS'}. Use --help.\n`); return 2; }
  if (options.help) { process.stdout.write(HELP); return 0; }
  // The executable explicitly loads its own server's configuration only after
  // validating CLI flags. The reusable module and its tests never load .env.
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const { Pool } = require('pg');
  const { sslOptions, positiveInteger } = require('../src/config/database');
  let pool;
  try {
    const env = process.env;
    if (!env.POSTGRESQL_HOST || !env.POSTGRESQL_USER || !env.POSTGRESQL_DATABASE || env.POSTGRESQL_PASSWORD == null) throw new Error('Database configuration missing');
    const port = positiveInteger(env, 'POSTGRESQL_PORT', 5432, 65535);
    const ssl = sslOptions(env);
    const storageRoot = path.resolve(env.STORAGE_ROOT || path.join(__dirname, '..', 'storage'));
    pool = new Pool({ host: env.POSTGRESQL_HOST, port, user: env.POSTGRESQL_USER, password: env.POSTGRESQL_PASSWORD,
      database: env.POSTGRESQL_DATABASE, ssl, max: 2, connectionTimeoutMillis: 5000,
      statement_timeout: 20000, idle_in_transaction_session_timeout: 30000, application_name: 'iot-image-import' });
    // Pool errors can otherwise print database connection details as an
    // unhandled event. Active-query failures are reported by the guarded run.
    pool.on('error', () => {});
    const store = require('../src/files/local-storage').createStore(storageRoot);
    const job = importer.createImporter({ pool, store, source: options.source, sourceDirectory: options.sourceDirectory,
      onProgress: progress => process.stdout.write(JSON.stringify(progress) + '\n') });
    const summary = await job.run({ apply: options.apply, companyId: options.companyId });
    process.stdout.write(JSON.stringify({ summary }) + '\n');
    return options.apply && (summary.failed || summary.pending || summary.changed) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Image import stopped: ${error.importFailure ? error.code : 'IMPORT_UNAVAILABLE'}. Check database/schema, storage configuration and permissions.\n`);
    return 1;
  }
  finally { if (pool) await pool.end().catch(() => {}); }
}

module.exports = { main, HELP };
if (require.main === module) main().then(code => { process.exitCode = code; });
