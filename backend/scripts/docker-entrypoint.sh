#!/bin/sh
# Wait for Postgres, apply Alembic migrations, then exec the container command.
set -e

cd /app

if [ "${LAI_RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running Alembic migrations..."
  alembic upgrade head
fi

exec "$@"
