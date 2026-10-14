#!/usr/bin/env bash
# Restore only into a NEW scratch database. Never drops an existing database.
# Pass a matching-version TimescaleDB server through libpq environment variables.
set -euo pipefail
umask 077
DUMP="${1:?Usage: db-restore-test.sh dump [iot_restore_test_unique_name]}"
TARGET="${2:-iot_restore_test_$(date -u +%Y%m%d%H%M%S)_${RANDOM}}"
[[ "$TARGET" =~ ^iot_restore_test_[a-z0-9_]+$ ]] && (( ${#TARGET} <= 63 )) || { echo 'Target must be a unique iot_restore_test_... database name' >&2; exit 2; }
[[ "$TARGET" != "${SOURCE_DB:-}" && "$TARGET" != "${PGDATABASE:-}" ]] || { echo 'Refusing to restore over a source database' >&2; exit 2; }
[[ -f "$DUMP" && -f "$DUMP.sha256" ]] || { echo 'Dump and its .sha256 manifest are required' >&2; exit 2; }
(
  cd "$(dirname "$DUMP")"
  if command -v sha256sum >/dev/null; then sha256sum --check "$(basename "$DUMP").sha256"; else shasum -a 256 -c "$(basename "$DUMP").sha256"; fi
)
pg_restore --list "$DUMP" >/dev/null
# createdb fails when TARGET exists. There is deliberately no DROP DATABASE.
createdb --maintenance-db=postgres "$TARGET"
psql -X -v ON_ERROR_STOP=1 -q -d "$TARGET" -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()' >/dev/null
pg_restore --no-owner --exit-on-error --dbname="$TARGET" "$DUMP"
psql -X -v ON_ERROR_STOP=1 -q -d "$TARGET" -c 'SELECT timescaledb_post_restore()' >/dev/null
COUNTS="SELECT 'telemetry_raw', count(*) FROM telemetry_raw UNION ALL SELECT 'production_hourly', count(*) FROM production_hourly UNION ALL SELECT 'machines', count(*) FROM machines UNION ALL SELECT 'users', count(*) FROM users UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations"
psql -X -v ON_ERROR_STOP=1 -At -d "$TARGET" -c "$COUNTS"
if [[ -n "${SOURCE_DB:-}" ]]; then psql -X -v ON_ERROR_STOP=1 -At -d "$SOURCE_DB" -c "$COUNTS"; fi
printf 'Restore completed into %s. Verify workflow/data checks before removing this scratch database.\n' "$TARGET"
