# Wingman Tower Agent Guide

Use this file for work inside `wingman-tower/`. Keep `agents.md` and `claude.md` identical.

## What this repo owns

`wingman-tower` is the authority backend for Wingman Be Free.

It owns:

- workspace creation, listing, and recovery
- group creation, membership, wrapped keys, and epoch rotation
- record sync, fetch, and visibility rules
- SSE real-time change notifications to connected clients
- storage prepare/upload/complete/read metadata
- service identity, NIP-98 auth, and OpenAPI output
- schema and runtime migrations

It does not own:

- browser materialization or UX
- CLI-specific local state
- app-specific translation of payload data into local UI rows
- optional Flight Logs memory behavior

## Read this first

- repo purpose: `README.md`
- backend contract types: `src/types.ts`
- public API surface: `src/openapi.ts`

## Code map

- `src/server.ts`: assembles the Hono app and registers routes
- `src/routes/`: route handlers by domain
- `src/routes/stream.ts`: SSE stream endpoint for real-time change notifications
- `src/services/`: business logic and DB-facing behavior
- `src/sse-hub.ts`: in-memory SSE fan-out hub with size-based ring buffer for replay
- `src/schema/`: bootstrap SQL, runtime schema checks, migrations, replay tools
- `src/auth.ts`: NIP-98 verification and workspace session key resolution
- `src/service-identity.ts`, `src/identity.ts`: service identity helpers
- `src/config.ts`: env-driven runtime config
- `tests/`: contract and behavior coverage
- `docs/prod-deploy.md`: deployment notes
- `docs/design/sync_progress.md`: sync-specific design notes
- `docs/sorage_current.md`: current storage notes

## Ownership by area

- workspace APIs and defaults: `src/routes/workspaces.ts`, `src/services/workspaces.ts`
- group APIs and rotation: `src/routes/groups.ts`, `src/services/groups.ts`
- record sync/fetch/summary: `src/routes/records.ts`, `src/services/records.ts`
- SSE real-time updates: `src/routes/stream.ts`, `src/sse-hub.ts`
- storage ACLs and blob metadata: `src/routes/storage.ts`, `src/services/storage.ts`
- admin and table viewer: `src/routes/admin.ts`, `src/admin-token.ts`

## Cross-app boundaries

Tower is the source of truth for these shared seams:

- `connection_token`
- workspace owner identity
- group ID versus `group_npub` epoch semantics
- record sync request and response shapes
- storage metadata and `content_url`
- NIP-98 auth expectations

When any of those change:

- update Flight Deck and Yoke in the same pass
- update `src/openapi.ts`
- update `src/types.ts`
- update or add tests that lock the new behavior

## Design rules

- Keep Tower schema-light for records. App meaning belongs in client translators.
- Use stable group UUIDs for durable ACL and membership logic.
- Treat `group_npub` as rotating crypto identity (encryption, write proofs), not the durable group key.
- Keep workspace, group, and storage boundaries explicit. Do not infer across them implicitly.
- Public storage access must remain opt-in and explicit.
- Any new route should have an OpenAPI entry unless there is a strong reason not to.

## Where to look for common tasks

- add a new endpoint:
  - route in `src/routes/`
  - service logic in `src/services/`
  - types in `src/types.ts`
  - OpenAPI in `src/openapi.ts`
  - tests in `tests/`
- change DB shape:
  - `src/schema/001_init.sql`
  - `src/schema/ensure-runtime-schema.ts`
  - `src/schema/run-migrations.ts` if needed
- change auth behavior:
  - `src/auth.ts`
  - affected route tests

## Things to avoid

- Do not put Flight Deck-specific local row shapes into Tower responses unless they are part of the shared contract.
- Do not make Flight Logs mandatory for normal workspace operations.
- Do not change field names across routes casually; Flight Deck and Yoke depend on stable naming.
- Do not add client-only convenience semantics to storage or record services without updating both clients.

## Validation

- Tower tests exercise the Docker-backed runtime and database. After any Tower
  source or schema change, rebuild and restart the local Tower container before
  running tests; otherwise tests may run against stale code or schema and fail
  misleadingly:

- For delegated implementation work, a worker may be told not to disrupt the
  shared runtime. That restriction applies only to the worker turn: the
  supervising manager must rebuild/restart local Tower and run the live smoke
  checks after accepting the change. Do not treat a passing source-only worker
  suite as completion of local Tower validation.

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
curl http://127.0.0.1:3100/health
```

- `set -a; . ./.env.example; set +a; bun test`

For local authenticated integration tests, use the shared identity in `../tmp/nsec.md`.

## Deployment (dev)

Tower runs locally via Docker Compose with `.env.prod`:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Health check: `curl http://127.0.0.1:3100/health`

This rebuild-and-restart step is required after Tower code or schema changes,
including before validation. This is a Bun runtime — no separate compile step.
Docker builds from source directly.

## Conventional Commits

- Every commit must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Use `<type>[optional scope][!]: <description>`, with an optional body and footer(s).
- Use `feat` for new features and `fix` for bug fixes. Other suitable types include `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`, and `revert`.
- Mark breaking changes with `!` before `:` and/or a `BREAKING CHANGE: <description>` footer.
- Keep unrelated changes in separate commits whenever practical.
