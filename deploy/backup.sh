#!/bin/sh
# Nightly logical backup of Postgres and an archive of uploaded files (02:30 UTC) with retention. Restore: see deploy/RUNBOOK.md.
set -e
mkdir -p /backups
while true; do
  now=$(date -u +%H%M)
  if [ "$now" = "0230" ]; then
    f="/backups/gutad-$(date -u +%Y%m%d-%H%M%S).dump"
    echo "[backup] writing $f"
    pg_dump -Fc -f "$f" && echo "[backup] ok $(du -h "$f" | cut -f1)"
    if [ -d /objects ]; then
      t="/backups/files-$(date -u +%Y%m%d-%H%M%S).tar.gz"
      tar -czf "$t" -C /objects . && echo "[backup] files ok $(du -h "$t" | cut -f1)"
    fi
    find /backups \( -name 'gutad-*.dump' -o -name 'files-*.tar.gz' \) -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
    sleep 70
  fi
  sleep 30
done
