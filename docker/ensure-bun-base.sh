#!/usr/bin/env bash
set -euo pipefail

BUN_VERSION="${TOWER_BUN_VERSION:-1.2.23}"
UPSTREAM_IMAGE="${TOWER_BUN_UPSTREAM_IMAGE:-oven/bun:${BUN_VERSION}}"
CACHE_IMAGE="${TOWER_BUN_CACHE_IMAGE:-wingman-tower-bun-base:${BUN_VERSION}}"
PULL_TIMEOUT_SECONDS="${TOWER_BUN_PULL_TIMEOUT_SECONDS:-60}"
REFRESH=0

if [[ "${1:-}" == "--refresh" ]]; then
  REFRESH=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--refresh]" >&2
  exit 2
fi

validate_base() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || return 1

  local actual_version
  actual_version="$(docker run --rm --entrypoint bun "$image" --version 2>/dev/null || true)"
  [[ "$actual_version" == "$BUN_VERSION" ]] || return 1

  # A cached runtime base must not contain a previous Tower application tree.
  docker run --rm --entrypoint sh "$image" -c \
    'test ! -e /app/package.json && test ! -e /app/src && test ! -e /app/node_modules' \
    >/dev/null 2>&1
}

pull_with_timeout() {
  local image="$1"
  docker pull "$image" &
  local pull_pid=$!
  local deadline=$((SECONDS + PULL_TIMEOUT_SECONDS))

  while kill -0 "$pull_pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "ERROR: timed out after ${PULL_TIMEOUT_SECONDS}s pulling $image" >&2
      kill "$pull_pid" 2>/dev/null || true
      wait "$pull_pid" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done

  wait "$pull_pid"
}

if [[ "$REFRESH" -eq 0 ]] && validate_base "$CACHE_IMAGE"; then
  echo "==> Using validated local Bun base: $CACHE_IMAGE" >&2
  printf '%s\n' "$CACHE_IMAGE"
  exit 0
fi

if [[ "$REFRESH" -eq 0 ]] && docker image inspect "$CACHE_IMAGE" >/dev/null 2>&1; then
  echo "WARN: ignoring invalid Bun cache $CACHE_IMAGE (wrong Bun version or contains Tower files)" >&2
fi

echo "==> Refreshing Bun base from $UPSTREAM_IMAGE" >&2
if ! pull_with_timeout "$UPSTREAM_IMAGE"; then
  echo "ERROR: Bun base refresh failed; the running Tower container was not changed." >&2
  echo "       Retry later or set TOWER_BUN_UPSTREAM_IMAGE to a reachable mirror." >&2
  exit 1
fi

docker tag "$UPSTREAM_IMAGE" "$CACHE_IMAGE"
if ! validate_base "$CACHE_IMAGE"; then
  echo "ERROR: pulled image $UPSTREAM_IMAGE is not a clean Bun $BUN_VERSION runtime." >&2
  exit 1
fi

echo "==> Cached validated Bun base as $CACHE_IMAGE" >&2
printf '%s\n' "$CACHE_IMAGE"
