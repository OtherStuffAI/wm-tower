# Wingman Tower Prod Deploy

This Docker bundle is for the backend-only Tower service. Flight Deck is not part of this stack.

## Required env

Tower runtime needs these values:

- `SUPERBASED_DIRECT_HTTPS_URL`
- `ADMIN_NPUB`
- `SUPERBASED_SERVICE_NSEC`
- `STORAGE_S3_ENDPOINT`
- `STORAGE_S3_ENDPOINT_PUBLIC`
- `STORAGE_S3_ACCESS_KEY`
- `STORAGE_S3_SECRET_KEY`
- `STORAGE_S3_BUCKET`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `GRAPH_DB_ADMIN_USER`
- `GRAPH_DB_ADMIN_PASSWORD`
- `GRAPH_DB_APP_USER`
- `GRAPH_DB_APP_PASSWORD`

If you use the provided Docker Compose stack, set these wrapper vars too:

- `TOWER_PORT`
- `TOWER_HOST_BIND_ADDRESS` (defaults to `127.0.0.1`)
- `TOWER_HOST_PORT`
- `MINIO_HOST_BIND_ADDRESS` (defaults to `127.0.0.1`)
- `MINIO_API_HOST_PORT`
- `MINIO_CONSOLE_HOST_PORT`

If you run raw `docker run`, pass the app port as `PORT`.

Optional because Tower has code defaults:

- `STORAGE_S3_REGION` default `us-east-1`
- `STORAGE_S3_FORCE_PATH_STYLE` default `true`
- `STORAGE_PRESIGN_UPLOAD_TTL_SECONDS` default `900`
- `STORAGE_PRESIGN_DOWNLOAD_TTL_SECONDS` default `900`
- `SUPERBASED_BILLING_MODE` default `disabled`; hosted paid mode should set `metered`
- `SUPERBASED_BILLING_GRACE_DAYS` default `21`
- `SUPERBASED_INITIAL_WORKSPACE_CREDITS` default `0`
- `SUPERBASED_LOW_BALANCE_THRESHOLD_CREDITS` default `24`
- `MGINX_URL`, `MGINX_API_KEY`, and `SUPERBASED_CREDITS_PRODUCT_ID` are required for metered purchase creation
- `DB_MAX_CONNECTIONS` default `10`
- `SUPERBASED_SERVICE_PUBKEY_HEX`
- `SUPERBASED_SERVICE_NPUB`
- `DB_WAIT_MAX_ATTEMPTS` default `40`

Tower optionally provides Nostr OIDC authentication for stock Forgejo. Set
`GIT_OIDC_ALLOWED_NPUBS` explicitly and preserve issuer, signing key, client
secret and callback URL. Forgejo owns all native OAuth, repository permissions,
Git and APIs. See [native migration](forgejo-native-auth-migration.md) before
updating any existing deployment. No worker or issue broker is deployed.

Prepare protected OIDC secret files without printing them:

```bash
./scripts/prepare-tower-git-deployment.sh /absolute/path/to/existing/.env.prod
docker compose --env-file .env.prod -f docker-compose.prod.yml config --quiet
```

The preparation script preserves existing files. Preserve the original issuer
and keys during migration; do not bootstrap replacement identities.

Important container note:

- The provided Docker Compose stack starts its own MinIO container and bucket bootstrap job.
- In that default stack, use `STORAGE_S3_ENDPOINT=http://minio:9000`.
- `STORAGE_S3_ENDPOINT_PUBLIC` should be the host or public URL clients will use for presigned downloads.
- The bundled MinIO API and console bind to host loopback by default. Containers
  still reach MinIO over the private Compose network at `http://minio:9000`.
- Only point Tower at an external S3/MinIO service if you are intentionally replacing the bundled storage container.

## First-time setup

1. Copy the env template:

```bash
cd /path/to/wingman-tower
cp .env.prod.example .env.prod
```

2. Edit `.env.prod`:

- set `SUPERBASED_DIRECT_HTTPS_URL` to the production Tower URL
- set `SUPERBASED_SERVICE_NSEC` to the stable service key
- set `DB_PASSWORD` to a real password
- set the main and graph database usernames/passwords explicitly; no credential defaults are accepted
- set `GIT_GATEWAY_ORIGINS` explicitly to the public HTTPS origin(s) that route
  Git smart HTTP to this stack's gateway
- set unique MinIO access and secret keys; no credential defaults are accepted
- set `STORAGE_S3_ENDPOINT_PUBLIC` to the MinIO URL your clients can reach
- leave `STORAGE_S3_ENDPOINT=http://minio:9000` unless you are using external S3
- leave `TOWER_PORT=3100` unless you intentionally want the app listening on a different internal port
- set `TOWER_HOST_PORT` if you want to publish the container on a different host port
- set `MINIO_API_HOST_PORT` / `MINIO_CONSOLE_HOST_PORT` if `9000` / `9001` are already occupied
- keep `TOWER_HOST_BIND_ADDRESS` and `MINIO_HOST_BIND_ADDRESS` on `127.0.0.1`
  for same-host access/reverse proxying. Set a private interface (or deliberately
  `0.0.0.0`) only when the deployment network requires direct host exposure.

Before starting or updating containers, validate interpolation without printing
the resolved configuration (which contains credentials):

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml config --quiet
```

## Start prod stack

```bash
cd /path/to/wingman-tower
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

This starts:

- `wingman-tower-postgres`
- `wingman-tower-minio`
- `wingman-tower-minio-init`
- `wingman-tower-b3`
- `wingman-tower-forgejo`
- `wingman-tower-git-gateway`

Forgejo has persistent config/data volumes and no host port. The optional plain
reverse proxy is published on `127.0.0.1:3180` and preserves the public URL.
Reverse-proxy identity authentication is disabled. Stock native OAuth, Git,
API, consent and permissions pass through unchanged; the proxy has no Tower
authorization or startup dependency. SSH, push-to-create, Actions and custom
Git hooks remain disabled by default.

Set `GIT_GATEWAY_BROWSER_ORIGIN` to the existing public Forgejo HTTPS origin.
For a fresh instance, configure the native external OIDC source once:

```bash
./scripts/bootstrap-forgejo-oidc.sh
```

For migration, preserve existing source IDs, issuer and immutable subject links.
Keep `GIT_FORGEJO_OIDC_ACCOUNT_LINKING=disabled`; do not auto-link by alias or
email. Old control/identity bootstrap scripts are retired and return an error.
Organizations, teams, accounts, usernames and repositories are managed natively
in Forgejo. Never restart permission reconciliation to repair access.

Postgres is created automatically, MinIO is bootstrapped with the configured bucket, and Tower waits for its dependencies, runs migrations, then starts the API.

Changing an existing database or MinIO credential in `.env.prod` does not rotate
the credential already stored in a Docker volume. Coordinate credential rotation
separately; do not delete or recreate volumes.

## Health checks

```bash
curl http://127.0.0.1:${TOWER_HOST_PORT:-3100}/health
curl http://127.0.0.1:${GIT_GATEWAY_HOST_PORT:-3180}/health
curl http://127.0.0.1:${GIT_GATEWAY_HOST_PORT:-3180}/ready
curl http://127.0.0.1:${MINIO_API_HOST_PORT:-9000}/minio/health/live
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f tower
```

The shipped Autopilot `git-credential-wingman` helper obtains a native Forgejo
OAuth credential through the session broker and Tower Nostr OIDC. Expiry causes
native sign-in again. Existing native tokens work while Tower is unavailable;
allowlist removal prevents new login only. Forgejo must revoke native access
separately when immediate removal is required.

## Canonical Tower release checks

There is currently no dedicated Tower deployment smoke-check script in this
repo. Until one exists, use these as the canonical manual release checks after
build/restart.

Set a base URL first:

```bash
export TOWER_URL="http://127.0.0.1:${TOWER_HOST_PORT:-3100}"
```

1. Verify health:

```bash
curl -fsS "$TOWER_URL/health"
```

Expected:

- JSON response has `status = "ok"`
- `service_npub` is present or explicitly `null` only in test/dev setups

2. Verify OpenAPI documents strict groupId mode and workspace-key mappings:

```bash
curl -fsS "$TOWER_URL/openapi.json" \
  | jq -e '
    .paths["/api/v4/records/sync"].post.parameters[]
      | select(.name == "x-superbased-strict-group-id-writes")
  '

curl -fsS "$TOWER_URL/openapi.json" \
  | jq -e '
    .paths["/api/v4/records/sync"].post.parameters[]
      | select(.name == "x-superbased-identity-strict")
  '

curl -fsS "$TOWER_URL/openapi.json" \
  | jq -e '.paths["/api/v4/user/workspace-key-mappings"].get'
```

Expected:

- both strict groupId headers are documented
- `/api/v4/user/workspace-key-mappings` is documented as an authenticated public
  user endpoint

3. Verify workspace-key mappings are reachable with auth:

```bash
curl -fsS \
  "$TOWER_URL/api/v4/user/workspace-key-mappings?workspace_service_npub=$WORKSPACE_SERVICE_NPUB" \
  -H "Authorization: $NIP98_GET_AUTH"
```

Expected:

- unauthenticated requests are rejected
- authenticated requests return `{ "mappings": [...] }`
- mapping rows include `user_npub`, `workspace_service_npub`, and
  `workspace_user_key_npub`

`$NIP98_GET_AUTH` must be a NIP-98 header signed for the exact GET URL.

4. Verify strict groupId mode rejects legacy write references:

Send a record sync body that contains `write_group_npub` as a write reference
and either:

- body field `strict_group_id_writes: true`
- header `x-superbased-strict-group-id-writes: true`
- header `x-superbased-identity-strict: group_id`

Expected:

- HTTP `400`
- response `code = "legacy_write_group_npub_forbidden"`
- response explains that `write_group_id` is the durable write reference
- `group_payloads[].group_npub` remains described as crypto epoch metadata

5. Verify compatibility mode still accepts legacy write refs with a warning:

Send the same kind of delegated write without strict mode, with valid
`group_write_tokens`.

Expected:

- HTTP `200`
- sync succeeds or fails according to normal write authorization
- response includes `warnings[]` entry with
  `code = "legacy_write_group_npub"` when `write_group_npub` is present

Local pre-release validation should include:

```bash
set -a; . ./.env.example; set +a; bun test tests/records.test.ts tests/write-contract-hardening.test.ts tests/openapi.test.ts tests/bot-workspace-keys.test.ts tests/stream-access.test.ts
git diff --check
```

Default `bun test` now skips only the physical S3 byte upload/download cases in
`tests/storage.test.ts`; storage prepare/auth/path coverage still runs. To make
the storage-inclusive pre-release gate explicit, start a reachable
S3-compatible endpoint and bucket matching `.env.example`, then run:

```bash
set -a; . ./.env.example; set +a; RUN_TOWER_STORAGE_S3_TESTS=true bun test tests/storage.test.ts
```

With the default local settings, that means MinIO at `http://127.0.0.1:9000`,
bucket `superbased-storage`, access key `superbased`, and secret
`superbased-secret`. `ConnectionRefused` under the storage-inclusive command is
an environment dependency failure, not an identity/groupId regression.

## Billing audits

Hosted metered deployments must run one billing audit per hour. The audit
charges each workspace at most once for a given hour via the unique
`(workspace_owner_npub, hour_start)` row in `workspace_usage_hourly_audits`, so
retries are safe.

Run this command on an hourly scheduler from the Tower app directory/container:

```bash
set -a; . ./.env.prod; set +a; bun run billing:audit
```

To audit a specific hour, pass an ISO timestamp. Tower normalizes it down to the
UTC hour:

```bash
set -a; . ./.env.prod; set +a; bun run billing:audit 2026-04-30T12:00:00.000Z
```

Expected successful output:

```json
{"ok":true,"hour_start":"2026-04-30T12:00:00.000Z","audits_created":3}
```

In `SUPERBASED_BILLING_MODE=disabled`, the command exits successfully and
creates no audits. Audit execution also performs the v1 retention transition:
expired `read_only_grace` accounts are marked `delete_eligible`. It does not
delete SQL rows or object-storage blobs.

## Admin web

Open:

- `https://<your-tower-domain>/admin`
- `https://<your-tower-domain>/table-viewer`
- `https://<your-tower-domain>/ui`

Use a browser Nostr extension logged in as `ADMIN_NPUB`, then click `Connect with Nostr`.

The `/admin` page supports:

- persistent Nostr login until explicit logout
- full-screen workspace inspection
- Postgres-backed workspace setup
- table inspection filtered by Postgres, encrypted records, storage, or operational tables
- connection-token generation for a selected workspace and app `npub`
- storage usage and encrypted-record metadata inspection
- selected workspace database-row deletion with explicit owner-npub confirmation
- operational billing overview at `GET /api/v4/admin/billing/overview`

The older `/table-viewer` route remains available for direct table inspection.

The `/ui` page is the public Tower-hosted Superbased dashboard. It uses the
same browser NIP-98 signing pattern, scoped to workspaces the authenticated user
can manage. It supports billing status, app namespace persistence, connection
detail regeneration, and encrypted record/storage metadata inspection.

## Generate a connection token

1. Open `/admin`
2. Connect with your admin Nostr identity
3. Open `Setup`
4. Select the workspace
5. Enter the app `npub` you want to target, for example Flight Deck's app namespace
6. Click `Generate Token`

The generated token can be used directly with Yoke:

```bash
cd /path/to/wingman-yoke
node src/cli.js init --token "<connection_token>"
```

## Update deploy

```bash
cd /path/to/wingman-tower
./rebuild_deploy_docker.sh
```

The deploy script validates and reuses a clean local Bun runtime image before
building Tower. Normal rebuilds therefore do not depend on Docker Hub metadata
being available. If the cache is missing, the script pulls `oven/bun:1.2.23`
with a bounded timeout and stops before replacing the running Tower container
if that pull fails.

Refresh the cached runtime intentionally after changing the pinned Bun version:

```bash
./rebuild_deploy_docker.sh --refresh-bun-base
```

`TOWER_BUN_UPSTREAM_IMAGE` can point at a registry mirror. The validated local
cache name defaults to `wingman-tower-bun-base:1.2.23` and can be changed with
`TOWER_BUN_CACHE_IMAGE`. Do not use a previously built Tower application image
as `TOWER_BUN_IMAGE`; the validator rejects images containing `/app` source or
dependencies to prevent recursive image layering.

## Stop stack

```bash
cd /path/to/wingman-tower
docker compose --env-file .env.prod -f docker-compose.prod.yml down
```
