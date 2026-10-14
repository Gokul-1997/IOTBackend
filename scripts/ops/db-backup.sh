#!/usr/bin/env bash
# Logical backup plus integrity manifest. Includes the database only: back up
# PROGRAM_TRANSFER_DIR and the collector journal separately at a consistent boundary.
set -euo pipefail
umask 077
: "${PGDATABASE:?Set PGDATABASE to the database to back up}"
[[ "$PGDATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo 'Invalid database name' >&2; exit 2; }
BACKUP_DIR=${BACKUP_DIR:-/var/backups/iot}
KEEP_DAYS=${KEEP_DAYS:-14}
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] && (( KEEP_DAYS >= 1 )) || { echo 'KEEP_DAYS must be a positive integer' >&2; exit 2; }
mkdir -p "$BACKUP_DIR"
LOCK_DIR="$BACKUP_DIR/.${PGDATABASE}.backup-lock"
mkdir "$LOCK_DIR" 2>/dev/null || { echo 'Another backup is running, or a stale lock needs inspection' >&2; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="${PGDATABASE}_${STAMP}.dump"
FILE="$BACKUP_DIR/$NAME"
PART=$(mktemp "$BACKUP_DIR/.${PGDATABASE}.XXXXXX.part")
cleanup() { rm -f "$PART"; rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT
[[ ! -e "$FILE" ]] || { echo 'Backup destination already exists' >&2; exit 1; }
pg_dump --format=custom --compress=6 --no-owner --file="$PART"
pg_restore --list "$PART" > /dev/null
mv "$PART" "$FILE"
(
  cd "$BACKUP_DIR"
  if command -v sha256sum >/dev/null; then sha256sum "$NAME"; else shasum -a 256 "$NAME"; fi
) > "$FILE.sha256"
if [[ -n "${S3_URI:-}" ]]; then
  # Treat the configured URI as a prefix, even without its trailing slash.
  # Otherwise the manifest could replace the dump at the same object key.
  REMOTE_PREFIX="${S3_URI%/}/"
  aws s3 cp --only-show-errors --sse AES256 "$FILE" "$REMOTE_PREFIX"
  aws s3 cp --only-show-errors --sse AES256 "$FILE.sha256" "$REMOTE_PREFIX"
fi
# Only prune after the new dump, manifest and optional remote upload succeed.
find "$BACKUP_DIR" -maxdepth 1 -name "${PGDATABASE}_*.dump" -mtime +"$KEEP_DAYS" -type f -exec sh -c 'rm -f "$1" "$1.sha256"' _ {} \;
echo "$(date -u +%FT%TZ) verified backup: $FILE (restore rehearsal still required)"
