#!/usr/bin/env bash
# Nightly logical backup of the IoT database (TimescaleDB), kept locally and
# optionally copied to S3.
#
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   the database (libpq variables)
#   BACKUP_DIR        where dumps are kept          (default /var/backups/iot)
#   KEEP_DAYS         local retention               (default 14)
#   S3_URI            e.g. s3://bucket/iot-db/      (optional; needs the aws CLI)
#
# A custom-format dump (-Fc) is compressed and restorable table by table.
# TimescaleDB: restore with db-restore-test.sh's steps (timescaledb_pre_restore /
# post_restore, same extension version). Run from cron, e.g.
#   30 1 * * *  /opt/iot/Backend/scripts/ops/db-backup.sh >> /var/log/iot-backup.log 2>&1
set -euo pipefail
BACKUP_DIR=${BACKUP_DIR:-/var/backups/iot}
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/${PGDATABASE}_${STAMP}.dump"
mkdir -p "$BACKUP_DIR"

echo "$(date -u +%FT%TZ) backup start → $FILE"
pg_dump --format=custom --compress=6 --no-owner --file="$FILE.part"
mv "$FILE.part" "$FILE"
# the table of contents must be readable, or the dump is not a backup
pg_restore --list "$FILE" > /dev/null
echo "$(date -u +%FT%TZ) backup ok: $(du -h "$FILE" | cut -f1)"

if [ -n "${S3_URI:-}" ]; then
  aws s3 cp --only-show-errors "$FILE" "$S3_URI"
  echo "$(date -u +%FT%TZ) copied to $S3_URI"
fi

find "$BACKUP_DIR" -name "${PGDATABASE}_*.dump" -mtime +"$KEEP_DAYS" -delete
