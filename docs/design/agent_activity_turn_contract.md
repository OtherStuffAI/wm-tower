# Agent activity turn lifecycle contract

Tower's `flightdeck_pg.agent_activity.snapshot` lifecycle is scoped by the pair
`activity_id` / `turn_id`. `activity_id` addresses the mutable snapshot row;
`turn_id` identifies the immutable Agent Direct turn that owns that row.

## Producer request

Autopilot must make one exact request adjustment after commit `02f9f2a`: pass
the existing `AgentActivityContext.turnId` into
`upsertFlightDeckPgAgentActivity` and serialize it as top-level `turn_id` in
every PUT body:

```json
{
  "channel_id": "...",
  "thread_id": "...",
  "trigger_message_id": "...",
  "turn_id": "stable Agent Direct turn id",
  "session_id": "...",
  "agent_npub": "...",
  "state": "working",
  "visibility": "user_visible",
  "sequence": 1784873857635002
}
```

`turn_id` is a non-empty string of at most 255 characters. It must remain the
same for every update and replay of one `activity_id`. A mismatch returns HTTP
409 with `code=agent_activity_turn_identity_mismatch` and the canonical current
snapshot. Existing sequence and terminal rules are unchanged:

- only a greater sequence changes a non-terminal snapshot;
- an exact state/sequence replay is idempotent and emits no new outbox row;
- a lower or conflicting sequence returns `stale_agent_activity_sequence`;
- a changed write after terminal state returns `agent_activity_terminal`.

Successful changed writes continue to return `agent_activity`, `audit`, and an
`outbox` object containing `id` and `row_version`.

## Flight Deck consumer contract

Tower serializes `turn_id` and `created_at` in PUT responses, GET hydration
records, audit metadata for changed writes, and both the top-level payload and
nested `payload.agent_activity` of
`flightdeck_pg.agent_activity.snapshot` events. Pre-contract database rows may
hydrate with `turn_id: null`; a later valid producer update can claim their turn
identity once.

Flight Deck should:

1. Add nullable `turn_id` and `created_at` fields to its activity model and
   Dexie materialization without inventing a turn identifier for legacy rows.
2. Reconcile repeated snapshots by `activity_id` and `turn_id`; sequence is
   monotonic only inside that lifecycle.
3. Treat `completed`, `failed`, and `cancelled` as tombstones only for the same
   lifecycle. An older turn's terminal replay must not clear a newer turn.
4. Choose a visible activity slot from non-terminal lifecycles by descending
   `created_at`, then descending `activity_id` as a deterministic tie-breaker.
   Never compare different turns by sequence.
5. Apply the same rules to initial hydration, SSE delivery, and reconnect
   hydration. Cover `turn B working -> turn A terminal`, repeated commentary,
   and hydration containing terminal A plus active B.

`created_at` is assigned when Tower first inserts the activity and is not
changed by lifecycle updates. `updated_at` describes snapshot mutation time and
must not be used as the primary cross-turn ordering field.

## Durable history and recovery (2026-09-08)

`expires_at` is a freshness hint, not retention or evidence of completion. GET
never deletes expired activity rows or commentary; completed, failed and
cancelled lifecycles remain available after expiry and after later runs.
The activity foreign key still cascades on intentional parent/workspace removal.

GET requires `channel_id` and accepts optional `thread_id` and `activity_id`.
Snapshot pages use `limit` (1..200, default 50) and opaque `cursor` / `next_cursor`,
ordered by immutable `created_at DESC, id DESC`. Timestamps in cursors retain
Postgres precision. A partial page never authorizes deleting other local rows.
`history_limit` is 0..200, default 50; zero omits history. Otherwise each returned
snapshot has its newest bounded `commentary_history`, ordered by sequence ASC.

For one exact `activity_id`, `before_sequence` loads older entries exclusively;
`commentary_next_before_sequence` is the next cursor or null. Alternatively,
`after_sequence` loads entries exclusively in ascending order, with
`commentary_next_after_sequence` when another page remains. Start at -1 to include
sequence zero. The two sequence cursors are mutually exclusive and require an
activity ID. All queries retain workspace, channel and optional thread boundaries.
Never hydrate an unbounded workspace history. TowerSyncService owns scoped pages,
materialization, reconnect recovery and the browser's persisted paging progress.

Working commentary insertion is transactional with its snapshot/outbox write and
independent of snapshot freshness and sequence selection. An unseen late working
entry is accepted even after terminal confirmation, returning HTTP 200 and the
unchanged current snapshot plus that entry in `commentary_history`. Its new SSE
outbox event carries the same delta. Replaying the same turn/sequence/content is
idempotent, including after later writes; conflicting content cannot overwrite
history. Full immutable publisher, channel, thread, trigger, session and turn
identity are enforced before accepting commentary. Only `working` user-visible
summary/body is recorded; terminal bodies are not history.

Consumers must persist each SSE commentary delta before coalescing current
snapshots. A lower snapshot sequence cannot suppress an attached history delta.
Producer sequence orders history; the outbox cursor orders delivery, including
late inserts below previously observed sequences. Reconnect delivery-cursor recovery (described below) recovers those late inserts
even when SSE replay is unavailable. Autopilot
should also drain its durable ordered publication queue before terminal delivery.

Validation uses an isolated test database only. The shared Tower runtime must be
rebuilt/restarted and smoke-tested by the manager after acceptance; the worker
has no restart authorization.

Worker validation evidence:

- `flightdeck-pg-api`, `flightdeck-pg-schema`, and `flightdeck-pg-outbox-cursors`
  suites pass (58 tests) against the isolated activity reliability test database.
  Coverage includes expiry retention, expired terminal refresh, late/out-of-order
  commentary after terminal, replay deduplication, immutable session/turn checks,
  bounded bidirectional history pages, and tied microsecond snapshot timestamps.
- Bun bundles `src/index.ts` successfully with target `bun`; diff whitespace check
  passes. Tower has no separate production compile script.
- Existing `tsc --noEmit` configuration includes tests outside `rootDir=src`;
  overriding rootDir reveals existing repository type errors, with no errors in
  the modified activity logic. This is not a clean repository typecheck claim.
- `privacy:check` reports the pre-existing tracked handoff
  `docs/handoffs/2026-09-05-headless-forgejo-bootstrap-final.md`; unrelated content
  is preserved. No sensitive detector output is copied here.
- Concurrent WApp scope-access route/service work was present before this change
  and remains uncommitted for its owner; its completeness is not established by
  these activity tests. Shared Tower activation and runtime smoke remain manager
  work after acceptance. No shared service was restarted or deployed.


## Delivery cursor recovery

Producer sequence is display order and is insufficient for finding late entries
below an existing sequence checkpoint. Every commentary row now has a generated
BIGINT `delivery_cursor`, serialized as a decimal string. Existing rows receive
values during the additive runtime migration. A per-activity index bounds scans.
The route transaction holds the parent upsert lock before allocating an entry
cursor, so committed inserts are ordered per activity. Failed transactions and
idempotent retries can leave cursor gaps; consumers must never infer missing
entries from those gaps or compare cursors between workspaces/activities.

Every GET snapshot includes `commentary_cursor` (maximum committed delivery
cursor for that exact activity/turn, or `"0"`), even with `history_limit=0`.
Use `activity_id` and `after_commentary_cursor=<saved decimal cursor>` for bounded
recovery in ascending delivery order. It excludes the saved cursor and cannot be
combined with sequence cursors. `commentary_next_cursor` is the last returned
entry cursor when more rows remain, otherwise null. Each returned entry contains
its own `delivery_cursor`; persist progress only with successful materialization.
Snapshot `commentary_cursor` is a high-water hint, not permission to skip pages.
The maximum accepted cursor is the signed BIGINT maximum; start recovery at 0.
Default/before-sequence history pages remain ordered by producer sequence.

PUT and SSE commentary deltas include `delivery_cursor` and the snapshot's new
`commentary_cursor`. Clients must recover gaps rather than advance a contiguous
checkpoint to an SSE high-water hint blindly. On first materialization the newest
bounded display page can seed its snapshot cursor, while older history remains
accessible through sequence pages. For known lifecycles, resume their saved
cursor after reconnect or fallback recovery, including terminal lifecycles that
can receive delayed producer commentary.

Follow-up validation: the same 58 API/schema/outbox tests pass with 1,990
assertions. Coverage adds 55 terminal-tail entries hiding a late lower sequence
from the default 50-row page, delivery-cursor paging of those old entries,
idempotent replay preserving the high-water mark, mixed-cursor rejection, and
repeat-safe migration of a schema without the delivery cursor. Bun bundle and
whitespace checks pass; the previously documented repository-wide check blockers
remain unchanged.
