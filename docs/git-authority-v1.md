> **RETIRED HISTORICAL DESIGN — DO NOT RUN THESE COMMANDS.**
> Tower now authenticates allowlisted Nostr identities only. Stock Forgejo owns
> all accounts, OAuth, permissions, Git and APIs. The capability gateway,
> permission writers, grants and issue broker described below are removed.
> Follow [the native migration handoff](forgejo-native-auth-migration.md).

# Tower Git authority v1

Tower Git authority v1 is the canonical control plane for private,
workspace-owned Git repositories. Forgejo is the selected Git object, smart
HTTP, pull request, review, and protected-branch provider. Tower does not store
Git objects, parse packs, or run repository code. The separate Tower Git
gateway consumes the internal capability contract and streams smart HTTP to a
private Forgejo enforcement replica.

## Operator configuration

The Git authority routes fail closed until all of these values are configured:

- `GIT_CAPABILITY_HASH_KEY`: an independent high-entropy key used only to
  HMAC opaque capabilities before persistence. Use at least 32 random bytes.
- `GIT_INTERNAL_SERVICE_TOKEN`: an independent high-entropy token presented by
  `wingman-git` in `x-wingman-git-service-token` for introspection/revocation.
- `GIT_SERVICE_AUDIENCE`: the exact configured gateway audience, normally
  `wingman-git`.
- `GIT_GATEWAY_ORIGINS`: comma-separated exact public HTTPS origins advertised
  to authenticated credential brokers. Configure this independently; Tower
  never derives it from its own, Forgejo's, or the browser gateway URL.
- `GIT_CAPABILITY_TTL_SECONDS`: 60–600 seconds; defaults to 300.
- `GIT_FORGEJO_BASE_URL`: private Forgejo origin; never a public bypass URL.
- `GIT_FORGEJO_CONTROL_TOKEN`: non-admin service-account token scoped to
  Tower-managed organizations and used only by the reconciler, never gateway
  request handling.
- `GIT_FORGEJO_WEBHOOK_SECRET`: independent HMAC secret, at least 32 bytes.
- `GIT_FORGEJO_WEBHOOK_URL`: Tower webhook URL reachable from Forgejo's private
  network.
- `GIT_ISSUE_BROKER_URL`: private origin of the isolated issue broker, normally
  `http://git-issue-broker:3190`.
- `GIT_ISSUE_BROKER_TOKEN`: an independent high-entropy token shared only by
  Tower and the private issue broker.
- `GIT_GATEWAY_TOWER_URL`: private Tower origin used by gateway/reconciler.
- `GIT_GATEWAY_FIXED_USERNAME`: smart-HTTP Basic username; defaults to `nostr`.
- `GIT_GATEWAY_PORT`: separate gateway listener; defaults to `3180`.
- `GIT_GATEWAY_BROWSER_ORIGIN`: exact public HTTPS Forgejo origin used for
  browser challenge binding and Forgejo-generated links.

Generate and distribute real values through the deployment secret mechanism.
Do not commit them, reuse the Tower service nsec, or reuse one value for both
hashing and internal authentication. The internal routes must be reachable only
over authenticated private HTTPS/network paths even though they also require
the service token.

## Security contract

- Repository grants use stable actor or Flight Deck PG group UUIDs. A rotating
  group npub is never a principal.
- Forgejo paths use a globally claimed, immutable workspace namespace and the
  Tower-validated repository slug. For example, workspace `otherstuff` and
  repository `kindling` resolve to `/otherstuff/kindling`, while UUIDs remain
  the internal authority and ACL keys.
- The namespace is claimed when the workspace is created and queued as its
  Forgejo organization name. It may be explicitly changed only before the
  organization is provisioned and before a repository exists. Changing the
  general workspace slug later does not silently move Git repositories or the
  provider organization. Empty, invalid, reserved, and legacy UUID-shaped
  `wm-<32 hex characters>` workspace slugs use the UUID-derived compatibility
  namespace. Readable names such as `workspace-alpha` are valid explicit
  namespaces.
- `main`, `staging`, and `deployed` are always protected, service-managed, and
  unavailable to direct or force pushes through v1 policy updates.
- Credential exchange uses a route-specific NIP-98 verifier: exact complete
  URL (including query order), exact method, mandatory payload hash, a 60-second
  age/skew window, and durable one-time event-ID consumption.
- Issue creation and comments use the same exact, payload-bound, 60-second
  NIP-98 contract. Successful mutation results are durably cached by event ID,
  so a client retry cannot create a duplicate issue or comment.
- The NIP-98 signer and resolved logical actor are stored independently. A
  workspace session key resolves to its registered actor; an agent signer is
  never replaced by the workspace owner.
- Opaque capabilities are random 256-bit values returned once. Tower persists
  only HMAC-SHA256 plus a 12-character hash prefix for correlation.
- Current credential exchanges send only `repository_id`, `audience`, and
  optional correlation context. Tower resolves the strict NIP-98 actor and
  derives every authorized transport scope and ref constraint from current
  actor/group grants. Capabilities are bound to repository, actor, signer,
  audience, transport scopes, ref constraints, policy revision, and optional
  session/task/workroom context. The gateway supplies the actual smart-HTTP
  service at introspection time. Task/workroom IDs are accepted only when they resolve in
  the same workspace and the logical actor has channel-read authority there.
- Introspection rechecks expiry, revocation, repository, audience, the gateway's
  actual service and required scope, current policy revision, signer mapping,
  workspace membership, current grant/group access, and ref constraints. A
  capability never proves repository administration, merge, approval,
  promotion, deployment, or arbitrary ref authority.
- Git audit rows are append-only at the database boundary and expose normalized
  decisions without bearer, Authorization, internal token, or plaintext
  capability material.
- Browser login uses a 60-second, one-time in-memory challenge bound to the
  exact public origin, login URL, POST body hash, nonce, audience, and expiry.
  A successful proof creates a random 256-bit, 15-minute `__Host-` session
  cookie with `HttpOnly`, `Secure`, and `SameSite=Lax`; only its SHA-256 hash is
  held by the gateway. Gateway restart invalidates all browser sessions.
- Each proxied UI request re-resolves workspace/device signers and current
  repository grants through Tower. Any stale active Forgejo binding fails the
  complete browser surface closed. Group membership and group-edge changes
  transactionally advance affected repository revisions, so removal becomes a
  denial immediately and remains denied until reconciliation completes.

## Routes

Public NIP-98 routes are under `/api/v4/git`:

- owner/admin workspace namespace claim before the first repository;
- repository create/list/read and authenticated canonical gateway-path
  resolution for credential brokers;
- grant create/list/revoke;
- policy read/update;
- redacted repository audit-event list;
- issue list/read for any actor with a visible repository grant;
- strict issue creation/commenting for `git.repo.write` and `git.repo.admin`;
- strict `POST /credential-exchanges`.

For a migration window, the exchange accepts `actor_id`, `service`, and
`requested_scopes` only when all three are present and remain a validated subset
of the resolved actor's current authority. New helpers must not send them.

Authenticated `GET /api/v4/flightdeck-pg/service` includes a `git` object only
when the capability hash key, internal gateway token, audience, and explicit
`GIT_GATEWAY_ORIGINS` are fully configured. Origins must be operator-supplied
HTTPS origins; Tower never derives Tower, Forgejo, organization, or repository
hostnames.

Internal service-token routes are:

- `POST /api/v4/git/internal/capabilities/introspect`;
- `POST /api/v4/git/internal/capabilities/revoke`.
- canonical Forgejo path resolution, desired reconciliation state, and exact
  revision acknowledgement under `/api/v4/git/internal/forgejo`.
  Tower now creates a pending Forgejo organization binding with every Flight
  Deck workspace. A private polling worker provisions the organization before
  any repository exists and re-runs when workspace membership or linked
  Forgejo identity changes.
- browser actor/session revalidation at
  `POST /api/v4/git/internal/forgejo/browser/validate`.

`POST /api/v4/git/forgejo/webhooks` verifies Forgejo HMAC signatures before it
durably deduplicates delivery IDs and appends normalized audit/projection
evidence. Raw bearer/service credentials and arbitrary webhook bodies are not
stored in audit rows.

Run the separate processes with `bun run git:gateway`, `bun run git:issues`, and
`bun run git:reconcile -- <repository-id>`. The gateway never loads the Forgejo
control token. The issue broker has no Forgejo token: it is the only fixed
private-network source allowed to use Forgejo reverse-proxy authentication for
API calls. The reconciler never returns its token to Tower or a client.

## Network and login assumptions

- Forgejo has no public host port. Only the gateway and reconciler network may
  reach it; direct or anonymous smart HTTP is unavailable.
- Reverse-proxy authentication remains available to the capability and issue
  broker data planes, but reverse-proxy auto-registration is disabled.
- Internal/basic login, open registration, push-to-create, SSH, user hooks, and
  Actions are disabled for v1.
- Browser authentication uses stock Forgejo OAuth2 client support against
  Tower's OIDC provider. The OIDC `sub` is the immutable Tower actor UUID.
  Forgejo owns its session cookie, CSRF checks, settings, and username changes.
  The gateway transparently proxies those requests while stripping every
  caller-supplied reverse-proxy identity header.
- Shadow users receive no password or client-visible provider token. Forgejo
  organization teams, repository collaborators, and branch-protection state
  are reconciled replicas, not canonical authority. Tower workspace owners and
  admins join Forgejo's stock Owners team; other repository actors join a
  Tower-managed team with no blanket repository access. Exact repository
  permissions continue to come from Tower grants.
- Before first OIDC login an actor may choose the preferred initial username
  through Tower. After linking, the native Forgejo Settings page owns renames.
  Tower's identity reconciler follows the immutable numeric Forgejo user ID and
  updates its username projection, so repository grants never use a mutable
  username as identity. No Forgejo fork or provider database mutation is used.
- Tower also supplies the actor's user-editable `display_name` as the Forgejo
  full name, so activity can show a friendly role label such as
  `Workspace Member` or `Automation Agent`
  independently of the chosen login alias.

## Browser gateway boundary

The same host port serves stock Forgejo Web UI and unchanged smart-HTTP Git
paths. Forgejo port `3000` remains private. Tower's public origin serves OIDC
discovery, authorization, token, user-info, and JWKS endpoints.
The browser proxy passes Forgejo sessions and native API authentication but
strips caller-supplied identity headers. The broker accepts
only its independent Tower token and supplies the already-authorized Tower actor
alias; it has no host port, public route, Forgejo token, or reconciliation
authority.

OpenAPI is authoritative for request and response shapes. The capability
plaintext is required in the introspection request body and must be sent over
private HTTPS; it is never returned by introspection or audit routes.

## Live validation

After operator approval to disrupt the shared Tower runtime, rebuild and run the
normal live smoke sequence:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
curl http://127.0.0.1:3100/health
```

Then run the authenticated Git authority smoke against the rebuilt process with
the deployment secrets available to Tower and the test client.
