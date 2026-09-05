#!/bin/sh
set -eu

runtime_role=${TOWER_RUNTIME_ROLE:-api}

case "$runtime_role" in
  git-gateway)
    echo "Starting stock Forgejo reverse proxy..."
    exec bun run git:gateway
    ;;
  git-issue-broker|git-identity-reconciler|git-org-reconciler|git-reconciler)
    echo "Retired runtime role: Tower authenticates only; Forgejo owns authorization." >&2
    exit 64
    ;;
  api)
    ;;
  *)
    echo "Unsupported TOWER_RUNTIME_ROLE: $runtime_role" >&2
    exit 64
    ;;
esac

ATTEMPTS=0
MAX_ATTEMPTS="${DB_WAIT_MAX_ATTEMPTS:-40}"

echo "Waiting for Postgres and running migrations..."
until bun run db:init >/tmp/coworker-db-init.log 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "Database init failed after ${MAX_ATTEMPTS} attempts."
    cat /tmp/coworker-db-init.log || true
    exit 1
  fi
  echo "Postgres not ready yet (attempt ${ATTEMPTS}/${MAX_ATTEMPTS}). Retrying in 3s..."
  sleep 3
done

if [ "${GRAPH_ENABLED:-false}" = "true" ]; then
  GRAPH_ATTEMPTS=0
  echo "Waiting for graph Postgres and running graph migrations..."
  until bun run graph:init >/tmp/coworker-graph-db-init.log 2>&1; do
    GRAPH_ATTEMPTS=$((GRAPH_ATTEMPTS + 1))
    if [ "$GRAPH_ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
      echo "Graph database init failed after ${MAX_ATTEMPTS} attempts."
      cat /tmp/coworker-graph-db-init.log || true
      exit 1
    fi
    echo "Graph Postgres not ready yet (attempt ${GRAPH_ATTEMPTS}/${MAX_ATTEMPTS}). Retrying in 3s..."
    sleep 3
  done
fi

echo "Database ready. Starting Tower API..."
exec bun run src/index.ts
