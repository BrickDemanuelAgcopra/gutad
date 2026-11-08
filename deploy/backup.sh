#!/bin/sh
# Nightly logical backup of Postgres (02:30 UTC) with retention. Restore: see deploy/RUNBOOK.md.
set -e
mkdir -p /backups
while true; do
  now=$(date -u +%H%M)
  if [ "$now" = "0230" ]; then
    f="/backups/gutad-$(date -u +%Y%m%d-%H%M%S).dump"
    echo "[backup] writing $f"
    pg_dump -Fc -f "$f" && echo "[backup] ok $(du -h "$f" | cut -f1)"
    find /backups -name 'gutad-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
    sleep 70
  fi
  sleep 30
done
