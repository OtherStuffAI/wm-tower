#!/usr/bin/env bash
#
# rebuild_deploy_docker.sh
#
# Rebuild and (re)deploy the Wingman Tower prod Docker stack:
#   - wingman-tower-postgres
#   - wingman-tower-minio
#   - wingman-tower-minio-init
#   - wingman-tower-b3
#
# Uses .env.prod as the env file for docker compose and docker-compose.prod.yml
# as the stack definition. Override either with ENV_FILE / COMPOSE_FILE.
# Always includes the required .env.fips and docker-compose.fips.yml settings.
#
# Usage:
#   ./rebuild_deploy_docker.sh              # rebuild + up -d
#   ./rebuild_deploy_docker.sh --no-cache   # force a clean image rebuild
#   ./rebuild_deploy_docker.sh --refresh-bun-base # refresh the cached Bun runtime
#   ./rebuild_deploy_docker.sh --down       # bring the stack down first
#   ENV_FILE=.env.prod.staging ./rebuild_deploy_docker.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="${ENV_FILE:-.env.prod}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

NO_CACHE=0
DOWN_FIRST=0
REFRESH_BUN_BASE=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE=1 ;;
    --down)     DOWN_FIRST=1 ;;
    --refresh-bun-base) REFRESH_BUN_BASE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file '$ENV_FILE' not found in $SCRIPT_DIR" >&2
  echo "Copy .env.prod.example to .env.prod and fill in the secrets." >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: compose file '$COMPOSE_FILE' not found in $SCRIPT_DIR" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: curl is required to verify Tower HTTP and FIPS health" >&2
  exit 1
fi

# Pick `docker compose` (plugin) or legacy `docker-compose`.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "ERROR: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

COMPOSE=("${DC[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
source "$SCRIPT_DIR/docker/compose-fips-options.sh"
append_tower_fips_options
"${COMPOSE[@]}" config --quiet
# Validate the public native gateway settings before changing containers.
bun scripts/fips-host-launchd.ts "${FIPS_ENV_FILE:-.env.fips}" > /dev/null

if [[ "$REFRESH_BUN_BASE" -eq 1 ]]; then
  TOWER_BUN_IMAGE="$(./docker/ensure-bun-base.sh --refresh)"
else
  TOWER_BUN_IMAGE="$(./docker/ensure-bun-base.sh)"
fi
export TOWER_BUN_IMAGE

echo "==> Using env file : $ENV_FILE"
echo "==> Using compose  : $COMPOSE_FILE"
echo "==> Using Bun base : $TOWER_BUN_IMAGE"
echo "==> Compose command: ${COMPOSE[*]}"

if [[ "$DOWN_FIRST" -eq 1 ]]; then
  echo "==> Bringing stack down first"
  "${COMPOSE[@]}" down
fi

if [[ "$NO_CACHE" -eq 1 ]]; then
  echo "==> Building Tower image with --no-cache"
  "${COMPOSE[@]}" build --no-cache tower
  echo "==> Starting stack"
  "${COMPOSE[@]}" up -d
else
  echo "==> Building Tower image"
  "${COMPOSE[@]}" build tower
  echo "==> Starting stack"
  "${COMPOSE[@]}" up -d
fi

echo "==> Current stack status"
"${COMPOSE[@]}" ps

# Both ordinary HTTP and native FIPS health must pass.
TOWER_HOST_PORT="$(grep -E '^TOWER_HOST_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
TOWER_HOST_PORT="${TOWER_HOST_PORT:-3100}"

echo "==> Probing http://127.0.0.1:${TOWER_HOST_PORT}/health"
curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  --retry 10 --retry-delay 1 --retry-all-errors \
  "http://127.0.0.1:${TOWER_HOST_PORT}/health"
echo

# FIPS success is required; ordinary HTTP health alone cannot accept a deploy.
FIPS_SETTINGS_FILE="${FIPS_ENV_FILE:-.env.fips}"
FIPS_NODE_NPUB="$(awk -F= '$1 == "TOWER_FIPS_NODE_NPUB" { print $2 }' "$FIPS_SETTINGS_FILE" | tr -d '\r')"
FIPS_MESH_ADDRESS="$(awk -F= '$1 == "TOWER_FIPS_MESH_ADDRESS" { print $2 }' "$FIPS_SETTINGS_FILE" | tr -d '\r')"
FIPS_PORT="$(awk -F= '$1 == "TOWER_FIPS_PORT" { print $2 }' "$FIPS_SETTINGS_FILE" | tr -d '\r')"
echo "==> Verifying Tower through its native FIPS gateway"
curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  --retry 10 --retry-delay 1 --retry-all-errors \
  -H "Host: ${FIPS_NODE_NPUB}.fips:${FIPS_PORT}" \
  "http://[${FIPS_MESH_ADDRESS}]:${FIPS_PORT}/health"
echo

echo "==> Done"
