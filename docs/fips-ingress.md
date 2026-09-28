# Tower FIPS ingress

Contract for task `b5f96311-d672-46ca-ab2d-e0bb0cdde8f8`, workspace
`2e5caefd-dd65-45d2-b747-ee874e8e5fc9`.

Tower starts an optional dedicated HTTP ingress in the same Bun process as the
ordinary listener, sharing Hono, database, identity, ACLs and SSE hub. For this
Docker Desktop deployment, a native macOS TCP forwarder connects the exact host
mesh interface to a **dedicated loopback-published Docker port**:

```text
WMapp/native client signs http://<native-daemon-npub>.fips:43100/exactpath?query
  -> existing native FIPS daemon and its local mesh address:43100
  -> fixed 127.0.0.1:43101 on macOS (Docker publish)
  -> dedicated Tower 0.0.0.0:43101 inside Docker
  -> fixed mesh Host/canonical URL adapter -> existing Hono app
```

The public Tower listener stays on its existing port 3100. The gateway has no
HTTP target selection, DNS, discovery, signing, keys, redirects or fallback.
TCP pipes preserve request/response bytes, backpressure, SSE and disconnects.
An upstream connection failure closes the mesh connection; it never selects
another destination. Upstream connect timeout is five seconds; streams have no
idle timeout. SIGTERM closes the listener and all gateway connections.

## Public configuration and deployment modes

`.env.fips.example` contains synthetic, internally consistent examples only.
Copy it to ignored `.env.fips`. Keep this file public-settings-only, unquoted
`TOWER_FIPS_*=value` lines. Do not copy Tower or FIPS daemon keys into it.

- `TOWER_FIPS_ENABLED=true` explicitly enables the ingress and gateway.
- `TOWER_FIPS_NODE_NPUB` is the existing native daemon's checksummed lowercase
  npub, not Tower/user identity. Autopilot and the local Tower ingress deliberately
  use this same transport identity in the supported single-daemon topology.
- `TOWER_FIPS_MESH_ADDRESS` is the exact native fd00::/8 IPv6, without brackets.
- `TOWER_FIPS_PORT=43100` is the **external mesh port**, used in the signed URL.
- `TOWER_FIPS_INGRESS_MODE=docker` selects internal `0.0.0.0:43101` in Tower;
  this is exposed only as `127.0.0.1:43101` by `docker-compose.fips.yml`.
  The native gateway always binds the mesh address and external port, regardless
  of ingress mode. Its target is hardcoded `127.0.0.1:43101`, never configurable.
- Omitted ingress mode defaults to `mesh` for native Tower installations, where
  Tower itself binds the mesh address/port and no host gateway is needed.

Docker never assumes the macOS mesh address exists in its namespace. The overlay
explicitly injects every FIPS variable. Its wildcard **internal container** bind
is necessary for Docker port forwarding and is not a host wildcard publish.
Other containers on Tower networks can reach this ingress; they still face the
fixed Host and existing route authentication. Do not publish 43101 on LAN/public
interfaces or change the gateway destination to 3100. Ordinary and dedicated
ports cannot be equal in Docker mode. The host gateway queries the existing
daemon through `TOWER_FIPS_DAEMON_CONTROL_SOCKET` (default
`/var/run/fips/control.sock`) before binding. It refuses to start unless the daemon
has a running active TUN, persistent identity, and npub/address exactly matching
`.env.fips`. It never reads private key material.

`./rebuild_deploy_docker.sh` is the single production rebuild/deploy entry point.
It always includes the FIPS overlay and requires `.env.fips` to declare
`TOWER_FIPS_ENABLED=true`. Override paths with `FIPS_ENV_FILE` and
`FIPS_COMPOSE_FILE` if needed. Missing, disabled or invalid settings stop deployment
before building or replacing containers. Deployment succeeds only after a health
request through the native FIPS gateway succeeds. The native FIPS daemon and host
gateway must be installed and running before deployment. Do not recreate Tower
using a separate Compose command: omitting the overlay removes the dedicated
ingress even while the native gateway remains running.

## Resolve the existing native daemon

Tower and Autopilot share the established native FIPS daemon. Read its public
identity and address without changing it:

```bash
FIPS_STATUS=$(fipsctl --socket /var/run/fips/control.sock show status)
TOWER_TRANSPORT_NPUB=$(jq -er .npub <<<"$FIPS_STATUS")
TOWER_MESH_ADDRESS=$(jq -er .ipv6_addr <<<"$FIPS_STATUS")
test "$(jq -er .persistent <<<"$FIPS_STATUS")" = true
test "$(jq -er .state <<<"$FIPS_STATUS")" = running
test "$(jq -er .tun_state <<<"$FIPS_STATUS")" = active
printf 'http://%s.fips:43100\n' "$TOWER_TRANSPORT_NPUB"
```

Fill `.env.fips` with those public values. Do not create a second identity,
daemon, control socket, or root launch service. The Tower service npub remains
different: the `.fips` hostname identifies transport, while
`/health.service_npub` identifies Tower.

## Manager activation (not performed by the source worker)

Run from `/Users/mini/code/wm/tower` after reviewing the source commit and
concurrent WApp state. These commands affect Tower and its host gateway only;
they do not restart Autopilot, Flight Deck, Postgres, MinIO or other services.

```bash
cp -n .env.fips.example .env.fips
# Review .env.fips against /var/run/fips/control.sock; npub/address must match.
docker compose --env-file .env.prod --env-file .env.fips \
  -f docker-compose.prod.yml -f docker-compose.fips.yml config --quiet
# Install the host gateway once before the first deployment. Skip this bootstrap
# when the service is already installed and running.
mkdir -p .runtime/fips-host "$HOME/Library/LaunchAgents"
bun scripts/fips-host-launchd.ts .env.fips > .runtime/fips-host/gateway.plist
plutil -lint .runtime/fips-host/gateway.plist
cp .runtime/fips-host/gateway.plist "$HOME/Library/LaunchAgents/studio.otherstuff.tower-fips-host.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/studio.otherstuff.tower-fips-host.plist"
launchctl print "gui/$(id -u)/studio.otherstuff.tower-fips-host"

./rebuild_deploy_docker.sh

set -a; . ./.env.fips; . ./.env.prod; set +a
FIPS_HOST="${TOWER_FIPS_NODE_NPUB}.fips:${TOWER_FIPS_PORT}"
curl --fail -H "Host: $FIPS_HOST" http://127.0.0.1:43101/health
curl -i -H 'Host: wrong.example' http://127.0.0.1:43101/health
# Required: 200 health above; 421 fips_host_mismatch for wrong Host.

curl --noproxy '*' --fail -H "Host: $FIPS_HOST" \
  "http://[${TOWER_FIPS_MESH_ADDRESS}]:${TOWER_FIPS_PORT}/health" \
  | jq -e --arg expected "$SUPERBASED_SERVICE_NPUB" '.status == "ok" and .service_npub == $expected'
```

The launch agent uses the renderer's absolute Bun/repo paths and `/var/empty`
working directory, avoiding automatic repository `.env` loading. It contains
only validated public FIPS settings. Logs are `.runtime/fips-host/stdout.log`
and `stderr.log`. launchd retries startup every ten seconds if the native mesh
interface is not ready. This is a user-login service; it needs the same logged-in
macOS user as the native FIPS node. For a later config update, regenerate the
plist and explicitly `bootout` then `bootstrap` this service. Do not bootstrap a
second copy or run the gateway in Docker. Inspect logs and `lsof -nP -iTCP:43100
-sTCP:LISTEN` / `lsof -nP -iTCP:43101 -sTCP:LISTEN` to confirm exact host binds.

Scoped gateway stop/recovery check (manager only):

```bash
launchctl bootout "gui/$(id -u)/studio.otherstuff.tower-fips-host"
# Mesh must now fail; HTTPS health must remain usable.
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/studio.otherstuff.tower-fips-host.plist"
```

For full rollback, stop the host service, then recreate only Tower using the base
Compose file without the FIPS overlay (keep FIPS settings out of `.env.prod`).
Do not remove volumes. Always retain the overlay on subsequent Tower deployments
while FIPS is enabled.

## Authentication and HTTP behavior

Send `Host: <valid-node-npub>.fips:<configured-port>` on the mesh socket.
Other or missing hosts return `421 fips_host_mismatch` before app dispatch.
Forwarded, X-Forwarded-*, CF-*, X-Real-IP and original/rewrite URL/host hints
are removed. The request URL and Host presented to Hono are rebuilt from the
fixed configured mesh origin plus the incoming path and query. Nothing is
fetched on behalf of a requested target. There is no open proxy or gateway key.

Use the broker to sign NIP-98 for the **actual mesh URL**, including the full
path and query in order, method and required body hash. For example the `u`
tag for a read is `http://<valid-node-npub>.fips:43100/api/v4/user/workspace-key-mappings`.
Existing canonical URL rules apply (HTTP port 80 canonicalizes away). Bun may
normalize unusual leading `//` paths on real sockets; signatures for changed
paths fail closed. Use the exact normal API path, not an alternative spelling.
An HTTPS signature cannot be reused on mesh, even with forwarding headers.
Route-specific auth, replay protection, workspace identity resolution and ACLs
remain in Tower. No global auth gate is added: public health and explicitly
public storage retain their normal visibility. API types and routes do not change.

Bodies and response streams are not buffered by the adapter. SSE receives the
same query/auth rules, Last-Event-ID and cancellation signal; the mesh listener
disables the Bun idle timeout so quiet streams are not closed by that timeout.
The adapter does not rewrite response bodies, redirects or cookies.

## Browser, cookies, CORS and storage limits

An HTTPS Flight Deck page cannot be assumed to fetch raw HTTP `.fips` URLs:
mixed-content, secure-context and native DNS/network constraints still apply.
Use the manager-coordinated native bridge while preserving the existing UI
origin and local workspace data. This Tower change supplies the wire endpoint
only. Pair and restrict destinations in the client; do not enable a generic
URL proxy, weaken global WebView security or silently fall back to HTTPS.

Origin is preserved. Existing Tower CORS remains wildcard without credential
allowance; the ingress adds no credentials or new allowed headers. Secure
cookies remain Secure and cannot be assumed usable over HTTP mesh. Browser
OIDC/admin cookie flows may therefore still require HTTPS. Use existing
brokered NIP-98 API transport rather than relaxing cookie flags.

Tower-generated storage content/complete URLs based on the incoming origin
use the mesh origin. Pre-signed S3 upload/download URLs and redirects remain
at the configured storage endpoint, which must be independently reachable.
No S3 URL is relabeled or proxied as mesh. Private storage authorization,
public opt-in, upload hashes and completion semantics remain unchanged.
Clients must handle those explicit external storage URLs separately; this
feature does not claim that all storage bytes travel over FIPS.

## Failure reporting and validation

Missing enablement leaves ingress disabled. Invalid settings or bind failure
produce a `[tower-fips] unavailable` log and leave ordinary Tower startup
running. Successful bind logs the exact public endpoint/address. These are
startup results, not continuous FIPS reachability probes; `/health` remains
Tower's normal health contract. A lost daemon/interface must surface as a
client connection failure. There is no automatic fallback or retry; after
repair, coordinate a Tower restart. No availability claim comes from HTTPS.

Source and isolated socket verification (no DB or shared runtime required;
43101 must be free because the test exercises the fixed production target):

```bash
set -a; . ./.env.example; set +a
bun test tests/fips-ingress.test.ts tests/fips-host-gateway.test.ts tests/auth.test.ts
git diff --check
```

The tests use ephemeral synthetic signing identities, never operator keys.
The real-socket test uses an ephemeral IPv6 loopback listener in place of the
native FIPS interface and the fixed 43101 loopback ingress; it proves TCP/HTTP
integration, not mesh daemon connectivity or live database state. It covers a
512 KiB signed POST/body integrity, exact encoded path/ordered query, forged
forwarding headers, Host rejection before dispatch, auth failures, redirect
passthrough, first SSE event, disconnect propagation and upstream loss.

An additional isolated **native host -> Docker publish** check is reproducible
with the current local Tower image (43101 must be free). It creates only a
throwaway fixture container, not Tower or its database. Run cleanup even if the
smoke command fails:

```bash
docker run --detach --rm --name tower-fips-isolated-review --entrypoint bun \
  --publish 127.0.0.1:43101:43101 \
  --mount type=bind,source=/Users/mini/code/wm/tower,target=/source,readonly \
  --workdir /source --env-file .env.example --env-file .env.fips.example \
  wingman-tower-tower tests/fixtures/fips-docker-ingress.ts
bun tests/fixtures/fips-docker-seam.ts
docker stop tower-fips-isolated-review
```

Source pickup evidence (2026-09-09): 18 tests / 139 assertions passed on native
Bun 1.3.0 and on Bun 1.2.23 in a disposable network-isolated container using the
current Tower image with source mounted read-only. The separate native host to
Docker publish fixture passed signed POST 200/body preservation, HTTPS-signed
401, and wrong Host 421. TypeScript checking of changed runtime/scripts passed;
Compose rendered exact loopback ports and all FIPS env; `plutil -lint` and
`git diff --check` passed. No shared container rebuild or gateway activation
was performed. The fixture is a synthetic authenticated echo, not live Tower
DB/ACL/SSE/storage acceptance.

For live brokered reads after activation, in an authorized manager session:

```bash
bun scripts/fips-live-smoke.ts
```

That script reads only Flight Deck's public app npub, signs each exact HTTPS or
mesh URL using the existing local capability broker, connects the mesh request
to the explicit native IPv6 with the fixed Host, and compares the task/workspace
identity. It also requires unsigned and HTTPS-signature-on-mesh rejection. It
prints no authorization tokens. Broker mesh signing denial is an explicit
failure to resolve with the supervisor, never a reason to load a raw key.
Live writes/SSE/storage acceptance still belongs to the primary supervisor.

Pending manager activation checks:

1. Execute the scoped activation above. Confirm dedicated/mesh/HTTPS health
   and native host/Docker binds. Do not treat source tests as live validation.
2. With a FIPS-capable client, broker-sign the exact endpoint for the same
   workspace reads and writes over each transport. Confirm common state,
   identity, ACL rejection and no duplicate records.
3. Verify live SSE delivery/recovery, cursor, disconnect/cancellation and
   storage prepare/upload/complete/private read using actual configured S3.
4. Send unauthenticated requests and an HTTPS-signed request with forged
   forwarding headers to mesh: require rejection. Wrong Host must return 421.
5. Verify native bridge behavior from the existing HTTPS UI and unchanged
   iPhone/HTTPS access. Stop/disconnect only the coordinated test mesh path;
   verify an explicit client failure while HTTPS remains usable.

Task remains `in_progress`; the primary worker owns task/frontend updates.
