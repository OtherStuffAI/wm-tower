#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$repo_dir/.env.prod"
compose_file="$repo_dir/docker-compose.prod.yml"
secret_file="$repo_dir/.runtime/tower-git-secrets/git-oidc-client-secret"

if [ ! -s "$secret_file" ]; then
  echo "run prepare-tower-git-deployment.sh first" >&2
  exit 1
fi

env_value() { awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$env_file"; }
issuer=$(env_value GIT_OIDC_ISSUER)
discovery_url="$issuer/.well-known/openid-configuration"
client_id=$(env_value GIT_OIDC_CLIENT_ID)
client_secret=$(tr -d '\r\n' < "$secret_file")
compose() { docker compose --project-name wingman-tower --env-file "$env_file" -f "$compose_file" "$@"; }

source_id=$(compose exec -T forgejo forgejo admin auth list | awk 'NR > 1 && $2 == "tower" { print $1; exit }')
if [ -n "$source_id" ]; then
  compose exec -T --user git forgejo forgejo admin auth update-oauth --id "$source_id" --name tower \
    --provider openidConnect --key "$client_id" --secret "$client_secret" --auto-discover-url "$discovery_url" \
    --scopes profile --scopes email --allow-username-change >/dev/null
else
  compose exec -T --user git forgejo forgejo admin auth add-oauth --name tower \
    --provider openidConnect --key "$client_id" --secret "$client_secret" --auto-discover-url "$discovery_url" \
    --scopes profile --scopes email --allow-username-change >/dev/null
fi
echo "Forgejo Tower OIDC authentication source is configured."
