# Tower FIPS ingress

Contract for task `b5f96311-d672-46ca-ab2d-e0bb0cdde8f8`, workspace
`2e5caefd-dd65-45d2-b747-ee874e8e5fc9`.

Tower optionally starts a second HTTP listener in its existing Bun process,
bound only to the operator-supplied FIPS IPv6 and port. Both listeners use the
same Hono instance, database pool, service identity, routes, ACLs and SSE hub.
The ordinary HTTPS deployment is unchanged. This is not a TCP proxy to the
existing public port, an internal forwarding route, or a signing gateway.

## Explicit setup

Supply these public settings to the **Tower process**, initially disabled:

```dotenv
TOWER_FIPS_ENABLED=true
TOWER_FIPS_NODE_NPUB=<actual checksummed lowercase node npub>
TOWER_FIPS_MESH_ADDRESS=<actual node fd00::/8 IPv6, without brackets>
TOWER_FIPS_PORT=43100
```

The wire base URL is `http://<valid-node-npub>.fips:<configured-port>`.
The npub identifies the FIPS node, not Tower's service or the user's identity.
Use the public npub and IPv6 belonging to the same operator-provisioned node.
Tower validates the npub checksum/type, IPv6 range and explicit port; it does
not discover nodes, resolve `.fips`, inspect daemon files, read private keys,
or attest that the operator's supplied npub and address belong together.
The operator owns that mapping and interface/firewall provisioning.

The exact address must exist in Tower's network namespace and the port must
be free. Do not substitute `::`, a LAN/public address, or a wildcard publish.
On Docker Desktop, a host macOS FIPS address is not automatically available
inside the Linux Tower container. The existing Compose configuration does not
provision this interface or pass these new settings. A manager must arrange
the FIPS interface in the Tower namespace and explicitly inject the four
settings before enabling it. An env-file used only for Compose interpolation
does not automatically inject arbitrary variables into the container.
Do not forward raw mesh TCP to Tower's existing HTTPS/proxy listener: that
bypasses this adapter's fixed-origin security boundary.

No shared runtime was restarted for this implementation. After coordination,
the manager must rebuild/restart Tower with the reviewed network/environment
configuration, retaining the existing database and public HTTPS route.

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
Existing canonical URL rules apply (HTTP port 80 canonicalizes away).
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

Source-only verification (no DB or shared listener required):

```bash
set -a; . ./.env.example; set +a
bun test tests/fips-ingress.test.ts tests/auth.test.ts
git diff --check
```

The ingress tests use an ephemeral synthetic signing identity, never an
operator key. Real signed requests must use the broker.

Pending manager activation checks:

1. Rebuild/restart Tower only after coordinating the namespace, exact bind
   and environment. Confirm the listening log and both HTTPS and mesh health.
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
