#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /absolute/path/to/existing/.env.prod" >&2
  exit 2
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_env=$1
target_env="$repo_dir/.env.prod"
secret_dir="$repo_dir/.runtime/tower-git-secrets"

if [ ! -f "$source_env" ]; then
  echo "existing environment file not found" >&2
  exit 1
fi

umask 077
mkdir -p "$secret_dir"
if [ ! -f "$target_env" ]; then
  cp "$source_env" "$target_env"
fi
chmod 600 "$target_env"

generate_secret() {
  target=$1
  if [ -s "$target" ]; then return; fi
  temp=$(mktemp "$secret_dir/.secret.XXXXXX")
  openssl rand -hex 32 > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$target"
}

upsert_env() {
  key=$1
  value=$2
  temp=$(mktemp "$repo_dir/.env.prod.XXXXXX")
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$target_env" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$target_env"
}

env_value() {
  key=$1
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$target_env"
}

hydrate_from_live_tower() {
  key=$1
  if [ -n "$(env_value "$key")" ]; then return; fi
  if ! docker inspect wingman-tower-b3 >/dev/null 2>&1; then
    echo "missing $key and live Tower container is unavailable" >&2
    exit 1
  fi
  value=$(docker inspect wingman-tower-b3 --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }')
  if [ -z "$value" ]; then
    echo "missing $key in both deployment sources" >&2
    exit 1
  fi
  upsert_env "$key" "$value"
}

for key in \
  DB_USER DB_PASSWORD SUPERBASED_DIRECT_HTTPS_URL ADMIN_NPUB \
  SUPERBASED_SERVICE_NSEC FLIGHT_DECK_PG_APP_NPUB \
  STORAGE_S3_ACCESS_KEY STORAGE_S3_SECRET_KEY \
  GRAPH_DB_ADMIN_USER GRAPH_DB_ADMIN_PASSWORD \
  GRAPH_DB_APP_USER GRAPH_DB_APP_PASSWORD
do
  hydrate_from_live_tower "$key"
done

# Never rotate a previously configured inline OIDC secret/key implicitly.
for key in GIT_OIDC_CLIENT_SECRET GIT_OIDC_SIGNING_KEY; do
  if [ -n "$(env_value "$key")" ]; then
    echo "Existing inline $key: migrate it to its protected file before using this helper; issuer/key continuity is required." >&2
    exit 1
  fi
done
generate_secret "$secret_dir/git-oidc-client-secret"
if [ ! -s "$secret_dir/git-oidc-signing-key.pem" ]; then
  signing_temp=$(mktemp "$secret_dir/.git-oidc-signing-key.XXXXXX")
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$signing_temp" 2>/dev/null
  chmod 600 "$signing_temp"
  mv "$signing_temp" "$secret_dir/git-oidc-signing-key.pem"
fi

upsert_env COMPOSE_PROJECT_NAME wingman-tower
upsert_env TOWER_ENV_FILE .env.prod
upsert_env TOWER_GIT_SECRETS_DIR ./.runtime/tower-git-secrets
upsert_env GIT_FORGEJO_BASE_URL http://forgejo:3000
upsert_env GIT_GATEWAY_HOST_BIND_ADDRESS 127.0.0.1
upsert_env GIT_GATEWAY_HOST_PORT 3180
if [ -z "$(env_value GIT_OIDC_CLIENT_ID)" ]; then
  upsert_env GIT_OIDC_CLIENT_ID forgejo
fi
upsert_env GIT_OIDC_CLIENT_SECRET ""
upsert_env GIT_OIDC_CLIENT_SECRET_FILE /run/tower-git-secrets/git-oidc-client-secret
upsert_env GIT_OIDC_SIGNING_KEY ""
upsert_env GIT_OIDC_SIGNING_KEY_FILE /run/tower-git-secrets/git-oidc-signing-key.pem
if [ -z "$(env_value GIT_OIDC_ISSUER)" ]; then
  upsert_env GIT_OIDC_ISSUER "$(env_value SUPERBASED_DIRECT_HTTPS_URL)/api/v4/git/oidc"
fi
if [ -z "$(env_value GIT_OIDC_REDIRECT_URI)" ]; then
  upsert_env GIT_OIDC_REDIRECT_URI "$(env_value GIT_GATEWAY_BROWSER_ORIGIN)/user/oauth2/tower/callback"
fi
upsert_env GIT_FORGEJO_OIDC_ACCOUNT_LINKING disabled

echo "Prepared ignored Tower Git deployment configuration without printing secrets."
