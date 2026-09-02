#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env.prod"
compose_file="$repo_dir/docker-compose.prod.yml"
secret_dir="$repo_dir/.runtime/tower-git-secrets"
token_file="$secret_dir/forgejo-control-token"
control_user=${FORGEJO_CONTROL_USERNAME:-tower-reconciler}

if [ ! -f "$env_file" ]; then
  echo "run prepare-tower-git-deployment.sh first" >&2
  exit 1
fi
if [ -s "$token_file" ]; then
  echo "Forgejo control token already provisioned; no change made."
  exit 0
fi

compose() {
  docker compose --project-name wingman-tower --env-file "$env_file" -f "$compose_file" "$@"
}

if ! compose exec -T forgejo wget -q -O /dev/null http://127.0.0.1:3000/api/healthz; then
  echo "Forgejo is not healthy" >&2
  exit 1
fi

if ! compose exec -T forgejo forgejo admin user create \
  --username "$control_user" \
  --email "$control_user@example.invalid" \
  --random-password \
  --random-password-length 64 \
  --must-change-password=false >/dev/null 2>&1; then
  if ! compose exec -T forgejo forgejo admin user list | awk -v user="$control_user" 'NR > 1 && $2 == user { found = 1 } END { exit !found }'; then
    echo "Forgejo control account bootstrap failed" >&2
    exit 1
  fi
fi

umask 077
mkdir -p "$secret_dir"
temp=$(mktemp "$secret_dir/.forgejo-control-token.XXXXXX")
if ! compose exec -T forgejo forgejo admin user generate-access-token \
  --username "$control_user" \
  --token-name "tower-reconciler-$(date -u +%Y%m%d%H%M%S)" \
  --scopes write:organization,write:repository \
  --raw > "$temp"; then
  rm -f "$temp"
  echo "Forgejo control token generation failed" >&2
  exit 1
fi
if [ ! -s "$temp" ]; then
  rm -f "$temp"
  echo "Forgejo returned an empty control token" >&2
  exit 1
fi
chmod 600 "$temp"
mv "$temp" "$token_file"
echo "Provisioned non-admin Forgejo control account and ignored local token file."
