#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env.prod"
compose_file="$repo_dir/docker-compose.prod.yml"
secret_dir="$repo_dir/.runtime/tower-git-secrets"
token_file="$secret_dir/forgejo-identity-token"
identity_user=${FORGEJO_IDENTITY_USERNAME:-tower-identity-reconciler}

compose() {
  docker compose --project-name wingman-tower --env-file "$env_file" -f "$compose_file" "$@"
}

if [ -s "$token_file" ]; then
  echo "Forgejo identity token already provisioned; no change made."
  exit 0
fi
if ! compose exec -T forgejo wget -q -O /dev/null http://127.0.0.1:3000/api/healthz; then
  echo "Forgejo is not healthy" >&2
  exit 1
fi
if ! compose exec -T forgejo forgejo admin user create \
  --username "$identity_user" \
  --email "$identity_user@example.invalid" \
  --random-password \
  --random-password-length 64 \
  --must-change-password=false \
  --admin >/dev/null 2>&1; then
  if ! compose exec -T forgejo forgejo admin user list | awk -v user="$identity_user" 'NR > 1 && $2 == user && $5 == "true" { found = 1 } END { exit !found }'; then
    echo "Forgejo identity administrator bootstrap failed" >&2
    exit 1
  fi
fi

umask 077
mkdir -p "$secret_dir"
temp=$(mktemp "$secret_dir/.forgejo-identity-token.XXXXXX")
if ! compose exec -T forgejo forgejo admin user generate-access-token \
  --username "$identity_user" \
  --token-name "tower-identity-reconciler-$(date -u +%Y%m%d%H%M%S)" \
  --scopes write:admin,read:user \
  --raw > "$temp"; then
  rm -f "$temp"
  echo "Forgejo identity token generation failed" >&2
  exit 1
fi
chmod 600 "$temp"
mv "$temp" "$token_file"
echo "Provisioned isolated Forgejo identity administrator token."
