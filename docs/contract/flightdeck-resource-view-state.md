# Flight Deck resource view state contract

Tower is authoritative for per-person view state. Flight Deck may update Dexie optimistically, but it must merge `viewed_activity_version` monotonically and consume Tower events for cross-device convergence.

## Resource payloads

Every typed thread, task, and document payload includes:

```json
{ "activity_version": 3 }
```

The value is a non-negative integer dedicated to attention activity. It is independent of `row_version`.

- Thread: each successfully created message in that thread advances it once.
- Task: a task content/state update or newly created task comment advances it once.
- Document: a non-archive-only document update or newly created document comment advances it once.
- Message/comment edits and deletes, assignments, archive-only changes, sync metadata, and administrative persistence do not advance it.
- The actor's view state advances to the resulting version in the same database transaction.

## List and rollout baseline

`GET /api/v4/flightdeck-pg/workspaces/{workspaceId}/resource-view-states`

Optional query: `resource_type=thread|task|document`, `channel_id=<uuid>`, `limit=1..200`, `cursor=<opaque>`.

On the viewer's first request in a workspace, Tower atomically snapshots every resource currently visible to that viewer as viewed. The response reports `baseline_created: true`. Later requests report `false`. This prevents historical resources from becoming unread at rollout; attention begins after that viewer's baseline.

```json
{
  "identity": {},
  "states": [{
    "workspace_id": "uuid",
    "viewer_actor_id": "uuid",
    "resource_type": "thread",
    "resource_id": "uuid",
    "scope_id": "uuid",
    "channel_id": "uuid",
    "activity_version": 3,
    "viewed_activity_version": 2,
    "unread": true,
    "row_version": 4,
    "created_at": "ISO-8601",
    "updated_at": "ISO-8601"
  }],
  "baseline_created": false,
  "next_cursor": "opaque-or-null"
}
```

Only currently visible, active resources are returned. Archived/deleted/inaccessible resources disappear from this list. Every visible resource is included even when it was created after rollout and has no persisted view-state row; such a resource is represented with `viewed_activity_version: 0` and `row_version: 0` and is unread when its activity version is positive.

Results use stable ascending `(resource_type, resource_id)` keyset pagination. The worker must keep filters unchanged and follow `next_cursor` until it is `null` before treating hydration as complete. `baseline_created` is true only on the first page/request that creates the viewer's rollout baseline.

## Mark one viewed

`PUT /api/v4/flightdeck-pg/workspaces/{workspaceId}/resource-view-states/{resourceType}/{resourceId}`

```json
{ "viewed_activity_version": 3 }
```

The supplied version identifies exactly what the modal/detail view loaded. It must not exceed the current resource `activity_version`; Tower returns `409 activity_version_ahead` if it does. Tower stores `max(existing, supplied)`, so offline replay and stale-device writes are monotonic and idempotent.

The response contains `state`, `changed`, and `outbox`. An idempotent/stale replay returns `changed: false` and `outbox: null`.

## Explicit bulk mark viewed

`POST /api/v4/flightdeck-pg/workspaces/{workspaceId}/resource-view-states/mark-viewed`

```json
{
  "resources": [
    { "resource_type": "thread", "resource_id": "uuid" },
    { "resource_type": "task", "resource_id": "uuid" }
  ]
}
```

The request must explicitly name 1–500 resources. Tower resolves each current `activity_version`, verifies every resource is visible, then marks the collection in one transaction. Navigation/list hydration must never call this endpoint implicitly.

## Outbox and SSE

Every changed view state creates a normal visible-event/outbox row:

```json
{
  "event_type": "flightdeck_pg.resource_view_state.updated",
  "entity_type": "resource_view_state",
  "entity_id": "<resource_id>",
  "operation": "updated",
  "entity_row_version": 4,
  "payload": {
    "viewer_actor_id": "uuid",
    "resource_type": "thread",
    "resource_id": "uuid",
    "activity_version": 3,
    "viewed_activity_version": 3,
    "row_version": 4
  }
}
```

These events are returned only to the matching `viewer_actor_id` through event polling/SSE. Resource mutation events (`thread.updated`, `task.updated`, `task_comment.created`, `doc.updated`, and `doc_comment.created`) include the parent `activity_version` in their payload. The worker should upsert resource versions first, then monotonically merge view-state events.

## Worker rules

1. A resource is unread only when `activity_version > viewed_activity_version`.
2. Mark viewed after the specific detail view has loaded successfully, using the loaded version.
3. Do not clear descendants when opening a channel, board, list, or section.
4. Apply local optimistic writes with `max(current, supplied)` and queue them offline.
5. Treat Tower `changed: false` as a successful idempotent replay.
6. Derive channel/section/Deck dots from visible unread descendants; do not persist aggregate dots.
