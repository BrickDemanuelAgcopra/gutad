#!/bin/sh
# Waits for Postgres, applies migrations (idempotent) and seeds (idempotent), then runs the given command.
set -e
if [ -n "$DATABASE_URL" ]; then
  for i in $(seq 1 60); do
    if pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then break; fi
    echo "[entrypoint] waiting for postgres ($i)"; sleep 2
  done
fi
if [ "$RUN_MIGRATIONS" != "false" ]; then
  node dist/db/migrate.js
fi
if [ "$RUN_SEED" = "true" ]; then
  node dist/db/seed.js
fi
exec "$@"
