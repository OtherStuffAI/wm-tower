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
