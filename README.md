# Wingman Tower

Tower is the shared authority behind Wingman Be Free. It gives people, agents, and apps one authenticated boundary for workspace data: identities and access, typed workspace APIs, compatibility record sync, file storage, and optional graph capabilities.

Tower is one of three distinct parts of the core system:

- **Tower holds the shared truth.** It owns authentication, workspaces, typed APIs, storage, and graph access boundaries.
- **Flight Deck coordinates the people and work.** It is the browser interface for chat, tasks, documents, approvals, and launching WApps.
- **Autopilot runs the work.** It owns agents, sessions, pipelines, triggers, managed apps, and their runtime lifecycle.

Flight Deck and Autopilot meet at Tower's contracts rather than owning each other's data. Tower authenticates NIP-98 requests, enforces workspace and group access, persists shared records and files, and exposes the APIs both human and agent workflows rely on. It does not render the coordination UI or supervise agent processes.

This repository contains the Bun API service, Postgres schemas, storage integration, OpenAPI contract, admin tools, and optional graph boundary for that backend.

## Runtime Notes

For the current Wingman Be Free workflow:

- Tower is the service that runs in local Docker for development
- Tower can also be deployed separately to production on its own URL
- Flight Deck is not intended to run in Docker for local dev; it is run locally via Wingman/PM2 and deployed to CapRover for the latest live version
- Yoke is a local CLI and should ideally be consumable via `npx wingman-yoke` or `bunx wingman-yoke`

The portable Docker bundle is backend-only: Tower, Postgres, MinIO, and the
stock Forgejo provider with a plain reverse proxy preserving its public URL.
Tower authenticates explicitly allowlisted Nostr identities through OIDC only.
Forgejo issues native OAuth credentials and owns all accounts, repository/team
permissions, Git and APIs. Autopilot's shipped helper signs in again through
Tower when a native credential expires; there are no Tower Git grants, permission
workers or issue broker. See [migration](docs/forgejo-native-auth-migration.md)
for the reviewed cutover and native access recovery. Flight Deck and Autopilot
stay outside this stack.

## Protocol Docs

The current Superbased V4 protocol drafts live in:

- `SBIPS/`

These proposals formalize the implemented Tower contract for auth, workspaces,
groups, record sync, storage, service discovery, and connection/bootstrap packaging.

## Production

Optional, explicitly configured mesh transport is documented in
[Tower FIPS ingress](docs/fips-ingress.md). It shares the existing app/database
and leaves public HTTPS in place.

Production deployment notes and the Docker Compose stack live in:

- `docs/prod-deploy.md`
- `docs/caprover-deploy.md`
- `docs/backup-and-restore.md`
- `.env.prod.example`
- `docker-compose.prod.yml`

Tower also exposes an admin web at `/admin` for `ADMIN_NPUB` users. It can inspect workspaces, create Postgres-backed Flight Deck workspaces, inspect tables, manage the public Tower profile, and generate workspace connection tokens for Yoke/Agent Connect. The older table-focused view remains available at `/table-viewer`.

## WApp feed reader state

[Implemented T1 source API](docs/contract/wapp-feed-t1-api.md) describes personal subscriptions,
flags, CAS/idempotency and PG recovery. The [proposed suite contract](docs/contract/wapp-feed-v1-proposed.md)
remains the baseline for other packages. Source implementation is not live activation;
legacy publishing remains intact.

## Opt-in device sync checkpoints

[Record device checkpoints v2](docs/contract/record-device-checkpoints-v2.md)
documents the Tower-only durable checkpoint extension, signed acknowledgements,
retention policy and separate Flight Deck integration follow-up. Existing v1
record-sync clients retain their current behavior.

## Negotiated bounded snapshots

[Bounded record snapshots v1](docs/contract/bounded-record-snapshots-v1.md) adds
opt-in v2 finite committed handover certificates and authenticated <=256 KiB
chunks for oversized canonical rows or actor sidecars. Whole JSON pages retain
the 1 MiB/200-entry limits. Existing v1, v2 and legacy sync remain compatible.

## Additive record access

[Additive record access v1](docs/contract/additive-record-access-v1.md) preserves
record cursors/checkpoints through channel and permission changes, catches up
newly readable history by partition, and retains prior downloads after access loss.

## Personal attention

[Personal attention v1](docs/contract/personal-attention-v1.md) documents the
additive task/document attention metadata, persisted personalized view projections,
existing-row backfill and independent user read/device checkpoint behavior.

## Message reference lookup

[Flight Deck message references](docs/contract/flightdeck-message-reference-lookup.md)
documents the narrow authorized message/owning-thread lookup for uncached links,
its error and branch semantics, and the separate runtime activation check.

## USD hosting billing

[USD prepaid hosting v1](docs/contract/hosting-billing-usd-v1.md) describes customer/workspace linking, exact byte-hour charges, the durable Tower runtime runner, Stripe test-mode top-ups, and the explicit live rollout gate. Existing workspaces remain safely unlinked.
