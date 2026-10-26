# Shared notification inbox — operations

Wire contract: `contract/notifications-v1.md`. Implementation map:

| Concern | Source |
| --- | --- |
| Schema (tables, sequence/hint functions, intake + view-bridge triggers), idempotent | `src/schema/notifications-v1.sql`, applied from `ensureRuntimeSchema()` at server start |
| Registry, cursors, rules resolution | `src/services/notification-core.ts` |
| Intake claim + projector (Tower rules, external events, tombstones) | `src/services/notification-projector.ts` |
| Inbox reads, CAS mutations, bulk, rules, sweep | `src/services/notification-inbox.ts` |
| External producers + source lifecycle | `src/services/notification-producers.ts` |
| Worker loop, maintenance/retention, queue stats | `src/services/notification-worker.ts` (started from `src/index.ts`) |
| Routes | `src/routes/notifications.ts` (registered on the Flight Deck PG router) |
| OpenAPI / types | `src/notifications-openapi.ts`, `src/types.ts` |

## How it runs

1. A DB trigger on `flightdeck_pg_outbox_events` writes a `flightdeck_pg_notification_intake` row **in the same
   transaction** as the source write (message created/revised, task comment, doc comment, task assignment).
   External producer events write their intake row in the ingest transaction.
2. `startNotificationWorker()` (in `src/index.ts`) polls the intake every `NOTIF_POLL_MS` (default 1000) with
   `FOR UPDATE SKIP LOCKED` leases (60 s). Projection and `done` commit in one transaction; a crash leaves a leased row
   that is recovered after lease expiry. Failures back off (5 s doubling, max 1 h) and are dead-lettered after 8 attempts
   (`state='dead'`, visible at `GET …/admin/notifications/queue`).
3. Reads (`items`, `item`, `changes`, `counts`, mutations) first run a per-recipient sweep that tombstones items whose
   ACL (`flightdeck_pg_record_access`), subject, source grant or expiry is no longer valid. A maintenance pass
   (`NOTIF_MAINTENANCE_MS`, default 10 min) applies retention.
4. The existing Web Push sender is untouched: it still runs inline after the write request. The inbox is additive.

## Flags (env, no secrets)

| Variable | Default | Effect |
| --- | --- | --- |
| `NOTIF_PROJECTOR` | `on` | `off` stops projection (intake rows keep accumulating and are projected when re-enabled) |
| `NOTIF_INBOX_API` | `on` | `off` returns 404 `notifications_not_enabled` and removes the descriptor/NStack capability |
| `NOTIF_POLL_MS` | `1000` | intake poll interval |
| `NOTIF_MAINTENANCE_MS` | `600000` | retention interval |

Rollback = set `NOTIF_INBOX_API=off`/`NOTIF_PROJECTOR=off` and restart; tables and user state are retained (additive schema).

## Local runtime and deployment mapping

* Local runtime container: `wingman-tower-b3` (compose service `b3`, `docker-compose.prod.yml`, env file `.env.prod`,
  port 3100). Rebuild/restart with `./rebuild_deploy_docker.sh`; `curl http://127.0.0.1:3100/health`.
  The schema migration runs automatically at start (`ensureRuntimeSchema`).
* Remote: CapRover app `tower-stable-api`, built from `origin/deployed-stable` (`docs/caprover-deploy.md`,
  `captain-definition`). Deploy via the `wingman-deploy` flow only when separately authorised.

## Validation

```bash
docker run -d --rm --name notif-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:16-alpine
set -a; . ./.env.example; set +a
RECORD_TEST_PORT=55432 bun test tests/notifications-inbox.test.ts
docker rm -f notif-test-pg
```

Live smoke (after the manager rebuilt Tower; broker-signed, no key material):

```bash
SESSION_ID=<session> WINGMAN_CAPABILITY=<capability> \
  bun scripts/notifications-smoke.ts --tower http://127.0.0.1:3100 --workspace <workspace-id> [--probe]
```

`--probe` (needs effective `workspace.manage`, e.g. the Rick agent actor) registers a temporary producer bound to the caller, publishes an event to the caller,
waits for the worker to project it, exercises CAS read and then revokes the temporary source.

## Not implemented (recorded gaps)

Alert sender/transports (Web Push migration, APNs, FCM), installation/transport registry
(`/me/notifications/*`), quiet hours, subject mutes, entitlement leases for external previews, silent baseline import,
record-subject events from external producers, scoped WApp inbox grants, delegated agent inbox reads, and replacing the
legacy inline `await evaluate…` after writes. Legacy Web Push still derives mentions from visible text; only the inbox
uses structured canonical mentions.
