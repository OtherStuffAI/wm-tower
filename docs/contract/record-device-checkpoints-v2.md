# Durable device record checkpoints (opt-in v2)

Tower backs up a cache's **explicitly acknowledged local commit**, not the last
page it sent. This is a Tower-only extension; deploying it does not activate or
change Flight Deck, Yoke, protocol v1, or the legacy bundled sync endpoint.

The authenticated NIP-98 identity resolves to an actor. Checkpoints are partitioned
by `(workspace_id, actor_id, client_id)`. A client ID identifies one durable local
cache, not a user credential or an authorization grant. Generate a random,
canonical lowercase, nonzero UUID when creating the cache. Keep it with the local
records. Different browsers/devices/caches use different IDs even for the same
signer. Cache loss requires a fresh ID and replacement snapshot; a checkpoint
alone cannot restore absent local rows.

## Discovery and negotiation

Authenticated `GET /api/v4/flightdeck-pg/service` adds `record_sync`:

```json
{
  "protocol_versions": [1, 2],
  "device_checkpoints": true,
  "client_id_format": "uuid",
  "max_clients_per_actor_workspace": 32,
  "max_page_tokens_per_client": 512,
  "page_token_idle_days": 7,
  "client_idle_days": 90
}
```

Opt in explicitly with `protocol_version=2`. Do not infer support from a build
number. Existing `protocol_version=1` requests retain their wire behavior,
actor-wide cursor bucket, snapshot semantics, and empty-poll cursor reuse.
Neither v1 nor v2 accepts the other's page tokens. Service discovery is additive.

All routes below require NIP-98 for the exact URL (including query parameters)
and method. POST requests additionally require the hash of the exact request
body, including the empty string for an empty registration request. Tower resolves
the actor from authentication; no request accepts a caller-selected actor.
Membership and authority epoch are rechecked in the service transaction.

Let `P = /api/v4/flightdeck-pg/workspaces/{workspaceId}/record-sync`.

| Operation | Request | Effect |
| --- | --- | --- |
| Register | `POST P/clients/{clientId}?protocol_version=2`, empty body | Creates bootstrap state; repeats return the same current registration. Does not ack. |
| Read | `GET P/clients/{clientId}?protocol_version=2` | Reads the acknowledged checkpoint and refreshes client activity. |
| Page | `GET P?protocol_version=2&client_id={clientId}&cursor={cursor}&limit=200` | Reads from exactly the supplied local position, issuing a new immutable page token. Does not ack. |
| Ack | `POST P/clients/{clientId}/ack?protocol_version=2` | Explicitly commits a server-issued page position after local materialisation. |
| Retire | `DELETE P/clients/{clientId}?protocol_version=2` | Idempotently removes this actor's registration and temporary tokens, freeing a capacity slot. Replacement caches use fresh IDs. |

Register/read/ack return:

```json
{
  "protocol_version": 2,
  "client_id": "10000000-0000-4000-8000-000000000001",
  "authority_epoch": "20000000-0000-4000-8000-000000000001",
  "initial_cursor": "30000000-0000-4000-8000-000000000001",
  "checkpoint_cursor": null,
  "checkpoint_revision": "0",
  "last_active_at": "2026-01-01T00:00:00.000Z"
}
```

`initial_cursor` is a durable bootstrap handle for this registration's snapshot
boundary. `checkpoint_cursor` is null until the first successful ack. Afterwards
it is a durable resume handle for the full acknowledged server state. Revisions
are decimal strings; compare as BigInt. Page responses retain the v1 canonical
changes, actor sidecar, partitions, snapshot, row and byte bounds, with
`protocol_version:2`, `client_id`, and `checkpoint_revision` added. The latter is
the checkpoint revision observed when `next_cursor` was issued. An empty v2 delta
page also issues a token so an older local position can obtain a token at the
current revision without moving its data position.

The page cursor is **required** in v2. The server never automatically chooses its
checkpoint over a supplied older valid local position. Bootstrap uses the
registration's `initial_cursor`; subsequent reads use the atomically committed
local cursor. A retained older token remains resumable even after a newer ack.
The initial handle and current checkpoint handle survive temporary token expiry
and cleanup. Older intermediate handles have the temporary retention policy.

Ack body (no extra fields):

```json
{"cursor":"40000000-0000-4000-8000-000000000001","expected_revision":"0"}
```

Use the page's `next_cursor` and `checkpoint_revision`. Acks validate that the
server issued the token for this exact actor, workspace, client and authority
epoch. The server stores the token's complete state, including snapshot boundary,
keyset, snapshot identity and delta handover, separately from temporary tokens.
Page-token state, epoch, issuance revision and issuance time never change; only
its successful-use activity can refresh.

## Acknowledgements and concurrency

Both `expected_revision` and the token's issuance revision must equal the current
checkpoint revision. A successful new ack increments the revision once. Retrying
the **current checkpoint cursor** returns success with the same revision, even if
the temporary token expired or was deleted. A retry of an older ack after another
ack won receives a conflict; it cannot roll back the checkpoint.

Only one concurrent branch can ack against a revision. Other branches receive
`checkpoint_conflict`, including a numerically further-ahead branch. Complete
snapshot order is checked as well: within the same snapshot, `(family,id)` cannot
go backwards; delta follows snapshot completion; delta cannot go back to snapshot
or to a smaller journal position. Snapshot comparisons use the database's keyset
ordering. A newly issued token from an older valid local cursor does not acquire
permission to regress the checkpoint.

After a conflict, read the checkpoint revision, retain the local committed cursor,
and request a page **from that local cursor** to obtain a fresh issuance revision.
Apply/commit that page before acking it. If it remains behind the server checkpoint,
keep replaying until it catches up; do not adopt a further server cursor without
having its records. Serialize materialisation/acks per cache and ignore cancelled
or stale-generation responses. Multiple devices need no shared revision.

## Snapshot, authority and retention

V2 uses the existing convergent snapshot: scan the current projection by keyset
at boundary B; terminal snapshot cursor switches to delta strictly after B;
deltas repair writes racing with snapshot pagination. `snapshot_complete` and
`partitions_complete` retain their meaning. Finish handover before claiming
convergence or retiring the previous authoritative generation. Canonical changes
and actor sidecars must commit atomically with the local cursor. Pending commands
remain independently durable. See [v1 semantics](../design/flightdeck-record-delta-v1.md)
for family visibility, canonical rows and resource bounds.

Authority mutations use [additive record access](additive-record-access-v1.md): channel/grant/group/membership changes preserve the workspace epoch and checkpoint. Newly readable existing history uses an independent targeted catchup position inside the page token; permission loss retains downloaded rows. Actual parent deletion emits explicit dependent tombstones.
Page scans use repeatable-read snapshots, then take the workspace clock shared
lock before the client row lock and token write. Concurrent clock/authority
changes retry with fresh authority. Checkpoint operations take the clock shared
lock before checking membership and locking client state; a later reset waits for
commit. Registration also serializes its actor/workspace capacity count with an
advisory lock, under read committed isolation so waiting registrations see new
clients. Cleanup never acquires the clock after a client lock.

Temporary tokens expire after seven days without valid use. Each client retains
at most 512 temporary tokens, independently of all other clients and the legacy
bucket. Each v2 page also deletes at most 64 expired tokens from its own bucket.
The durable initial state and acknowledged checkpoint do **not** expire at the
old seven-day TTL and cannot be evicted by legacy or other-device churn.

Abandoned devices have a separate **90-day idle policy**. Successful register,
read, page and ack operations refresh client activity, without implying commit.
At 90 days the registration is unusable. New registration can reclaim abandoned
registrations for that actor/workspace, cascading their tokens; already reclaimed
IDs report `client_not_registered`. Idle rows are reclaimed lazily, not by a
background timer. Retire explicitly when replacing a cache or freeing a slot.
There are at most 32 retained registrations per actor/workspace; capacity rejects
new clients instead of evicting another active cache. Reset registrations count
until explicitly retired or abandoned; clients should retire their old registration
when replacing it after a reset.

No journal pruning is introduced here. Durability of a checkpoint does not promise
indefinite delta availability after a restore or future retention policy. V2
returns `history_pruned` if the required prefix is missing or older than
`flightdeck_pg_record_clock.journal_floor`. Future journal pruning must delete only
a prefix and advance this floor atomically while holding the workspace clock lock;
interior deletion or incompatible restore must change the authority epoch. Snapshot
continuations also require history from their boundary for handover. Never silently
move to a newer position when history is unavailable.

## Errors and recovery

| Status / error | Client action |
| --- | --- |
| 400 `unsupported_protocol_version`, `invalid_client_id`, `cursor_required`, `invalid_cursor`, `invalid_limit`, `invalid_checkpoint_revision`, `invalid_body` | Correct negotiation or request. |
| 401 | Restore signer authentication; IDs grant no access. |
| 403 `workspace_membership_required` | Deny future requests; retain downloaded rows read-only under the same actor/workspace identity and preserve pending commands. |
| 409 `reset_required`, `history_pruned`, `client_expired`, `client_not_registered` | Preserve downloaded rows and pending commands; repair with an authorized replacement cursor/cache ID when needed. These responses include `reset:{discard_authoritative:false,preserve_pending:true,preserve_downloaded:true}`. |
| 409 `page_token_invalid` | Unknown, foreign, expired or evicted temporary token. Keep pending commands; use a checkpoint only if it corresponds to the actual local records. If no valid local resume handle remains, replace the cache generation and ID and snapshot. Never jump forward to an acknowledged server position. |
| 409 `checkpoint_conflict` | Read checkpoint, replay from local committed position with a fresh revision; do not alter rows based on checkpoint metadata alone. |
| 409 `checkpoint_regression` | Continue replay from the local committed position until caught up; server state remains unchanged. |
| 409 `client_capacity` | Retire an owned obsolete registration or wait for abandonment. No active device was evicted. |
| 413 `record_too_large` | No cursor advance; resolve the oversized canonical record/identity. |

## Flight Deck follow-up (not implemented by this rollout)

Tower owns authoritative state. TowerSyncService remains the sole network/update
and materialisation owner; Dexie liveQuery and Alpine render committed local state.
Keep acknowledgement traffic out of UI components.

1. Discover v2 support and explicitly enable the protocol in a separate client
   rollout. Retain the v1 path for unsupported servers; never mix cursor formats.
2. Persist a cache UUID, authoritative generation, committed cursor and revision
   alongside records. Clearing/recreating Dexie must generate a new UUID. A restored
   cursor without matching records is cache loss, not checkpoint recovery.
3. Register only that cache. Bootstrap from `initial_cursor` only for its new
   generation; resume from the **local** cursor whenever present. Server metadata
   can recover a lost acknowledgement response, not missing local materialisation.
4. Atomically commit canonical rows, actors, snapshot metadata and `next_cursor` in
   Dexie. Only after that transaction commits, enqueue a signed ack. Persist enough
   ack intent to retry after interruption. A lost ack must never undo local progress.
5. Coalesce/serialize pages and acks per cache. Compare request cursor, generation,
   client and authority before applying a response. On conflicts replay from local
   state; on reset cancel in-flight work, hide old authoritative rows and preserve
   unresolved commands. Finish snapshot handover before replacing the old generation.
6. Test offline/reload/ack-loss recovery, same-user multiple devices, cache clearing,
   revoked authority, old local cursors, branch requests, abandonment and capacity.
   No Flight Deck build number or client activation accompanies this Tower change.

## Upgrade and validation

Bootstrap and `ensureRuntimeSchema` install the same additive v2 SQL block.
Existing legacy cursors, states, activity timestamps and authority epochs are not
rewritten by this extension. Re-running the migration preserves existing v2
checkpoints and revisions. Existing unrelated authority migrations may legitimately
reset epochs when upgrading an older runtime; do not suppress those resets.

The disposable-DB suites are `tests/flightdeck-record-delta.test.ts` and
`tests/flightdeck-record-checkpoints.test.ts`. Set `RECORD_TEST_PORT` to a disposable
PostgreSQL instance (not shared/staging/production). They create/drop unique
databases and use only test-local ephemeral signing identities. Skipped tests are
not validation. A supervising manager must separately rebuild/restart local Tower
and verify health and authenticated smoke behavior after reviewing the committed
worker change. This worker does not restart shared services or deploy remotely.
