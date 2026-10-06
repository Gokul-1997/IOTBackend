#!/usr/bin/env bash
# Restore a dump into a scratch database and check it: the proof that the
# backup works. Run weekly, and before any risky change.
#
#   db-restore-test.sh <dump file> [scratch db name]
#   PGHOST PGPORT PGUSER PGPASSWORD    a server with the SAME TimescaleDB version
#   SOURCE_DB (optional)               the live database, to compare row counts
set -euo pipefail
DUMP="$1"; TARGET="${2:-iot_restore_test}"
echo "$(date -u +%FT%TZ) restoring $DUMP into $TARGET"
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $TARGET" -c "CREATE DATABASE $TARGET"
psql -X -q -d "$TARGET" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()" > /dev/null
pg_restore --no-owner --exit-on-error --dbname="$TARGET" "$DUMP"
psql -X -q -d "$TARGET" -c "SELECT timescaledb_post_restore()" > /dev/null

COUNTS="SELECT 'telemetry_raw', count(*) FROM telemetry_raw UNION ALL
        SELECT 'production_hourly', count(*) FROM production_hourly UNION ALL
        SELECT 'machines', count(*) FROM machines UNION ALL
        SELECT 'users', count(*) FROM users UNION ALL
        SELECT 'schema_migrations', count(*) FROM schema_migrations"
echo "restored:"; psql -X -At -d "$TARGET" -c "$COUNTS"
if [ -n "${SOURCE_DB:-}" ]; then echo "source now:"; psql -X -At -d "$SOURCE_DB" -c "$COUNTS"; fi
echo "$(date -u +%FT%TZ) restore ok — drop $TARGET when done"
