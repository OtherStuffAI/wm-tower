# Pre-journal archived lifecycle tombstones

## Problem

The record capture trigger emits a `delete` journal entry when a scope or channel
is archived. Scopes and channels archived **before** the record journal existed
have no journal entry at all. The trigger install also backfilled them into
`flightdeck_pg_record_current`. Retained or adopted client caches therefore never
learn these resources are gone, and keep asking for optional channel surfaces
(reactions, agent/response activities). Tower correctly refuses those reads
because the channel is archived.

## Repair (`archived_lifecycle_tombstones_v1`)

The block in `src/schema/001_init.sql` runs on fresh bootstrap. It also runs at
startup from `ensureRuntimeSchema`, inside the record schema transaction after
`priority_record_sync_v1`. It does three things:

- It locks scopes and channels in `SHARE ROW EXCLUSIVE` mode.
- It finds every scope or channel with `archived_at IS NOT NULL` whose latest
  `flightdeck_pg_record_heads` entry is not a `delete` (either no head or an
  `upsert` head).
- For each one, it calls the normal `flightdeck_pg_record_emit(...,'delete')` with
  the canonical row, which is exactly what the trigger would have written. It
  emits channels before scopes, ordered by workspace, `archived_at` and id.

Effects:

- Each tombstone gets a new journal position, so existing delta cursors, bounded
  handovers and cache-adoption challenges all receive it.
- The emit removes the stale archived row from `record_current` and sets the head
  to `delete`.
- Epoch and `access_revision` do not change, so there is no reset.
- Reruns are no-ops, because a `delete` head already covers the row.
- Later restoration and re-archival keep the normal trigger contract.

## Visibility

Visibility is unchanged. Scope/channel `delete` tombstones go only to actors who
hold current, unrevoked grants, through the existing lifecycle branch in
`flightdeck-record-visibility.ts`. Archived `channel.read` stays refused, and the
existing 400/403 mapping is unchanged.

## Known client boundary (not changed here)

Flight Deck/Ambulando hide cached descendants through projection filtering when a
scope or channel is archived. A channel tombstone also gates channel message,
activity and thread reads. Remaining client-side gaps:

- Reaction reads are not gated by archive state.
- A scope-only tombstone does not gate reads for its child channels.
- SSE hydration skips the gate.

## Validation

```bash
RECORD_TEST_PORT=<disposable-port> bun test ./tests/archived-lifecycle-tombstones.test.ts
```
