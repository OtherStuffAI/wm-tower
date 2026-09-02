# CapRover Tower and Forgejo Deploy

Tower on CapRover is a service group, not a single container. The public stable
installation uses these origins:

```text
Tower API: https://tower-stable-api.b.otherstuff.ai
Forgejo gateway: https://tower-stable-forgejo.b.otherstuff.ai
MinIO API: https://tower-stable-minio.b.otherstuff.ai
```

The GitHub branch deploy rebuilds each Bun-based app independently. Postgres,
MinIO, and the private Forgejo provider are sibling CapRover apps with
persistent data and stable app names. They are recreated only when their
image/config is intentionally changed.

## App Layout

Use one CapRover app per container:

| App | Purpose | Deploy source | Persistent path | Exposed |
| --- | --- | --- | --- | --- |
| `tower-stable-postgres` | Main Tower Postgres | CapRover PostgreSQL one-click app or `postgres:16-alpine` image | `/var/lib/postgresql/data` | No |
| `tower-stable-minio` | S3-compatible object storage | CapRover MinIO one-click app | `/data` | Yes, if clients need presigned upload/download URLs |
| `tower-stable-api` | Tower API | GitHub branch `deployed-stable` | None | Yes |
| `tower-stable-forgejo-provider` | Private stock Forgejo provider | `caprover/forgejo.captain-definition` | `/var/lib/gitea` | No |
| `tower-stable-forgejo` | Public Tower Git/Forgejo gateway | GitHub branch `deployed-stable` | None | Yes |
| `tower-stable-git-issue-broker` | Private Tower-authorized issue adapter | GitHub branch `deployed-stable` | None | No |
| `tower-stable-git-identity-reconciler` | Private OIDC identity projection worker | GitHub branch `deployed-stable` | None | No |
| `tower-stable-git-org-reconciler` | Private workspace-to-Forgejo organization worker | GitHub branch `deployed-stable` | None | No |

If graph memory is enabled, add a fourth app:

| App | Purpose | Deploy source | Persistent path | Exposed |
| --- | --- | --- | --- | --- |
| `tower-stable-graph-postgres` | AGE graph Postgres | `apache/age:release_PG16_1.6.0` image | `/var/lib/postgresql/data` | No |

CapRover gives each app an internal service DNS name:

```text
srv-captain--tower-stable-postgres
srv-captain--tower-stable-minio
srv-captain--tower-stable-api
srv-captain--tower-stable-graph-postgres
srv-captain--tower-stable-forgejo-provider
srv-captain--tower-stable-forgejo
srv-captain--tower-stable-git-issue-broker
srv-captain--tower-stable-git-identity-reconciler
srv-captain--tower-stable-git-org-reconciler
```

## Why This Works

CapRover GitHub deploy is one app at a time. It reads the root `captain-definition` and builds one container from this repo.

The stack therefore works as separate CapRover apps:

1. Create persistent Postgres and MinIO apps once.
2. Create the private persistent Forgejo provider once.
3. Create the Tower API, gateway, issue broker, identity reconciler, and organization reconciler from
   GitHub branch `deployed-stable`.
4. Set `TOWER_RUNTIME_ROLE` per Bun app so the shared image starts the intended
   process.
5. Point every app at its siblings using CapRover internal DNS.
6. Future pushes to `deployed-stable` rebuild the GitHub-backed apps; data
   remains in the Postgres, MinIO, and Forgejo volumes.

Do not put a public domain on `tower-stable-forgejo-provider` or
`tower-stable-git-issue-broker`. The only public Forgejo origin must terminate
at `tower-stable-forgejo`, which proxies to the private provider.

This replaces the manual SSH flow of `git pull`, `docker compose up --build`, and container relaunch for the API. Database/storage containers stay running unless you intentionally update them.

## Tower API GitHub Deploy

Create `tower-stable-api` as a normal CapRover web app.

Recommended settings:

- Has Persistent Data: off
- Deployment method: GitHub
- Branch: `deployed-stable`
- Root `captain-definition`: included in this repo
- Container HTTP Port: `3100`
- Websocket Support: on if Flight Deck uses SSE/WebSocket routes through this hostname

Required API env:

```env
NODE_ENV=production
PORT=3100

SUPERBASED_DIRECT_HTTPS_URL=https://tower-stable-api.b.otherstuff.ai
ADMIN_NPUB=npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul
FLIGHT_DECK_PG_APP_NPUB=REPLACE_WITH_FLIGHT_DECK_APP_NPUB
SUPERBASED_SERVICE_NSEC=nsec1...

DB_HOST=srv-captain--tower-stable-postgres
DB_PORT=5432
DB_NAME=coworker_v4
DB_USER=postgres
DB_PASSWORD=REPLACE_WITH_POSTGRES_PASSWORD
DB_MAX_CONNECTIONS=10

STORAGE_S3_ENDPOINT=http://srv-captain--tower-stable-minio:9000
STORAGE_S3_ENDPOINT_PUBLIC=https://tower-stable-minio.b.otherstuff.ai
STORAGE_S3_REGION=us-east-1
STORAGE_S3_ACCESS_KEY=REPLACE_WITH_MINIO_ROOT_USER
STORAGE_S3_SECRET_KEY=REPLACE_WITH_MINIO_ROOT_PASSWORD
STORAGE_S3_BUCKET=superbased-storage
STORAGE_S3_FORCE_PATH_STYLE=true
STORAGE_PRESIGN_UPLOAD_TTL_SECONDS=900
STORAGE_PRESIGN_DOWNLOAD_TTL_SECONDS=900

GRAPH_ENABLED=false
GRAPH_DB_HOST=srv-captain--tower-stable-graph-postgres
GRAPH_DB_PORT=5432
GRAPH_DB_NAME=tower_graph
GRAPH_DB_ADMIN_USER=postgres
GRAPH_DB_ADMIN_PASSWORD=REPLACE_WITH_GRAPH_POSTGRES_PASSWORD
GRAPH_DB_APP_USER=tower_graph_app
GRAPH_DB_APP_PASSWORD=REPLACE_WITH_GRAPH_APP_PASSWORD
GRAPH_DB_MAX_CONNECTIONS=10
GRAPH_AGE_GRAPH_NAME=tower_memory
DB_WAIT_MAX_ATTEMPTS=40
```

The same values are available as a copyable template in:

```text
caprover/tower-api.env.example
```

For this stable deployment, use the exact Git/OIDC URL values from that
template:

```env
GIT_FORGEJO_BASE_URL=http://srv-captain--tower-stable-forgejo-provider:3000
GIT_FORGEJO_WEBHOOK_URL=http://srv-captain--tower-stable-api:3100/api/v4/git/forgejo/webhooks
GIT_ISSUE_BROKER_URL=http://srv-captain--tower-stable-git-issue-broker:3190
GIT_GATEWAY_TOWER_URL=http://srv-captain--tower-stable-api:3100
GIT_GATEWAY_BROWSER_ORIGIN=https://tower-stable-forgejo.b.otherstuff.ai
GIT_OIDC_ISSUER=https://tower-stable-api.b.otherstuff.ai/api/v4/git/oidc
GIT_OIDC_REDIRECT_URI=https://tower-stable-forgejo.b.otherstuff.ai/user/oauth2/tower/callback
```

CapRover uses direct environment variables rather than the Docker Compose
secret-file mounts. Do not set any corresponding `*_FILE` variable unless the
file is actually mounted into that app. Generate independent values for
`GIT_CAPABILITY_HASH_KEY`, `GIT_INTERNAL_SERVICE_TOKEN`,
`GIT_FORGEJO_WEBHOOK_SECRET`, `GIT_ISSUE_BROKER_TOKEN`, and
`GIT_OIDC_CLIENT_SECRET`. Paste the PKCS#8 RSA private key, including its PEM
newlines, into `GIT_OIDC_SIGNING_KEY`. Never reuse `SUPERBASED_SERVICE_NSEC`.

If graph memory is enabled:

```env
GRAPH_ENABLED=true
GRAPH_DB_HOST=srv-captain--tower-stable-graph-postgres
GRAPH_DB_PORT=5432
GRAPH_DB_NAME=tower_graph
GRAPH_DB_ADMIN_USER=postgres
GRAPH_DB_ADMIN_PASSWORD=REPLACE_WITH_GRAPH_POSTGRES_PASSWORD
GRAPH_DB_APP_USER=tower_graph_app
GRAPH_DB_APP_PASSWORD=REPLACE_WITH_GRAPH_APP_PASSWORD
GRAPH_DB_MAX_CONNECTIONS=10
GRAPH_AGE_GRAPH_NAME=tower_memory
GRAPH_ALLOWED_NPUBS=npub1...
```

## Forgejo Apps

### Private provider

Create `tower-stable-forgejo-provider` from
`caprover/forgejo.captain-definition`, set container HTTP port `3000`, and do
not enable a public domain. Apply `caprover/forgejo.env.example` and attach
persistent directory:

```text
/var/lib/gitea
```

Use a named volume such as `tower-stable-forgejo-provider-data`. The rootless
image writes its generated configuration and SQLite database below
`/var/lib/gitea`; mounting only `/etc/gitea` does not preserve either one.

The CapRover overlay uses dynamic task addresses, so the provider template
trusts CapRover's private `10.0.0.0/8` network for reverse-proxy identity. This
is safe only while the provider remains unexposed and every app on the
CapRover host is operator-controlled. Do not publish provider port `3000`.

### Public gateway

Create `tower-stable-forgejo` from this repository's `deployed-stable` branch,
set container HTTP port `3180`, enable HTTPS and WebSocket support, and attach
the stable domain `tower-stable-forgejo.b.otherstuff.ai`. Apply
`caprover/git-gateway.env.example`. Its `GIT_INTERNAL_SERVICE_TOKEN` must equal
the Tower API value.

### Private issue broker

Create `tower-stable-git-issue-broker` from `deployed-stable`, set container
HTTP port `3190`, do not enable a public domain, and apply
`caprover/git-issue-broker.env.example`. Its token must equal the Tower API
`GIT_ISSUE_BROKER_TOKEN`.

### Identity reconciler

Create `tower-stable-git-identity-reconciler` from `deployed-stable`, leave it
without a public domain, and apply
`caprover/git-identity-reconciler.env.example`. The worker follows native
Forgejo username changes by immutable OIDC/provider user ID.

### Workspace organization reconciler

Create `tower-stable-git-org-reconciler` from `deployed-stable`, leave it
without a public domain, and apply `caprover/git-org-reconciler.env.example`.
`GIT_GATEWAY_TOWER_URL` and `GIT_FORGEJO_BASE_URL` are the configurable Tower
and private Forgejo URLs. The worker uses the isolated non-admin control token
to create one private Forgejo organization per Tower workspace and reconcile
Tower owners/admins into Forgejo's Owners team. Tower workspace creation only
queues this projection, so provider downtime does not roll back the workspace.

The provider still requires one-time creation of the non-admin repository
reconciler identity, the isolated identity lookup account, and the `tower`
OpenID Connect authentication source. Perform those bootstrap operations from
the provider app's CapRover terminal after Tower OIDC discovery returns HTTP
200. Never expose the generated provider tokens or add them to the Tower API
app.

## Postgres App

Use CapRover's PostgreSQL one-click app when available. Otherwise create an app named `tower-stable-postgres`, mark it persistent, and deploy:

```json
{
  "schemaVersion": 2,
  "imageName": "postgres:16-alpine"
}
```

The same deploy JSON is available in:

```text
caprover/postgres.captain-definition
```

Set env:

```env
POSTGRES_DB=coworker_v4
POSTGRES_USER=postgres
POSTGRES_PASSWORD=REPLACE_WITH_POSTGRES_PASSWORD
```

The same values are available in:

```text
caprover/postgres.env.example
```

Add persistent directory:

```text
/var/lib/postgresql/data
```

Do not expose this app publicly unless you intentionally need remote DB access.

## MinIO App

Use CapRover's MinIO one-click app when available. Configure the access key, secret key, API domain, and console domain there.

Minimum required values:

```env
MINIO_ROOT_USER=REPLACE_WITH_MINIO_ROOT_USER
MINIO_ROOT_PASSWORD=REPLACE_WITH_MINIO_ROOT_PASSWORD
```

The same values are available in:

```text
caprover/minio.env.example
```

Persistent directory:

```text
/data
```

Tower expects bucket `superbased-storage`. Create it once in the MinIO console or with `mc`:

```bash
mc alias set tower-minio https://tower-stable-minio.b.otherstuff.ai REPLACE_WITH_MINIO_ROOT_USER REPLACE_WITH_MINIO_ROOT_PASSWORD
mc mb -p tower-minio/superbased-storage
mc anonymous set none tower-minio/superbased-storage
```

Set `STORAGE_S3_ENDPOINT_PUBLIC` to the externally reachable MinIO API URL used by browsers for presigned uploads/downloads.

## Stable Branch Update Flow

1. Fast-forward the release commit to `deployed-stable`.
2. CapRover rebuilds each GitHub-connected Tower app.
3. `docker/entrypoint.sh` selects the process using `TOWER_RUNTIME_ROLE`; only
   the `api` role waits for Postgres and runs migrations.
4. Existing Postgres, MinIO, and Forgejo volumes remain attached to their
   service apps.
5. Verify:

```bash
curl -fsS https://tower-stable-api.b.otherstuff.ai/health
curl -fsS https://tower-stable-api.b.otherstuff.ai/api/v4/git/oidc/.well-known/openid-configuration
curl -fsS https://tower-stable-forgejo.b.otherstuff.ai/health
curl -fsS https://tower-stable-forgejo.b.otherstuff.ai/ready
curl -fsS https://tower-stable-minio.b.otherstuff.ai/minio/health/live
```

## Rollback

Use CapRover's previous deployment rollback for `tower-stable-api`, or move `deployed-stable` back to a known-good commit and rebuild.

Do not delete persistent Postgres or MinIO apps during rollback. If an app must be deleted and recreated, keep the same app name and do not remove its persistent volume.
