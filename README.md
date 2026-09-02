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
private Forgejo/Tower Git gateway plus isolated issue-broker data plane. Flight
Deck and Autopilot stay outside this stack.

## Protocol Docs

The current Superbased V4 protocol drafts live in:

- `SBIPS/`

These proposals formalize the implemented Tower contract for auth, workspaces,
groups, record sync, storage, service discovery, and connection/bootstrap packaging.

## Production

Production deployment notes and the Docker Compose stack live in:

- `docs/prod-deploy.md`
- `docs/caprover-deploy.md`
- `docs/backup-and-restore.md`
- `.env.prod.example`
- `docker-compose.prod.yml`

Tower also exposes an admin web at `/admin` for `ADMIN_NPUB` users. It can inspect workspaces, create Postgres-backed Flight Deck workspaces, inspect tables, manage the public Tower profile, and generate workspace connection tokens for Yoke/Agent Connect. The older table-focused view remains available at `/table-viewer`.
