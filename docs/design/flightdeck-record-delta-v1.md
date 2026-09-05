# Flight Deck record delta v1

Contract-ready: 2026-09-05. Producer implementation and isolated validation are in progress; do not enable before successful capability negotiation. Existing `/sync` and its cursors remain unchanged.

## Negotiation and requests

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/record-sync?protocol_version=1[&cursor=OPAQUE][&limit=200]`, existing NIP-98 and app identity headers. Version is mandatory. Successful responses advertise `protocol_version: 1` and `families`. A 404/unsupported version means use legacy sync. Keep a separate cursor per protocol/workspace/viewer. This is a record-family stream, not a replacement for unrelated directory, invocation, WApp publishing, or presence APIs.

Families: `scope`, `channel`, `thread`, `message`, `task`, `task_comment`, `task_assignment`, `doc`, `doc_comment`, `file`, `file_folder`, `audio_note`, `daily_note`, `personal_wapp`, `resource_view_state`.

## Response

`{protocol_version:1, families:string[], mode:'snapshot'|'delta', changes:Change[], next_cursor:string, has_more:boolean, snapshot_id:string|null, snapshot_complete:boolean, partitions_complete:string[], bounds:{max_rows:200,max_bytes:1048576}}`.

Each change is `{family,id,operation:'upsert'|'delete',version:string,workspace_id,scope_id:string|null,channel_id:string|null,row:object|null}`. Versions are decimal commit-order positions, compared as integers/BigInt, never timestamps or JavaScript floating point. Explicit deletes have `row:null`. Composite identities: task assignment `task_id:actor_id`; view state `viewer_actor_id:resource_type:resource_id`.

Rows are **full canonical stored PG records**, including null fields, metadata, actor UUIDs and row_version, not patches or Dexie rows. SQL timestamps are JSON timestamp strings. Derived legacy transport fields (sender_npub, mentions, assignments, unread, signed content URLs) are not stored columns and must be derived through existing actor/reference translators. Task assignments are independent canonical records: an absent assignments property never clears assignments. Resource activity_version comes from the corresponding task/thread/doc; view-state rows carry viewed_activity_version. Tombstones identify the old ownership context on moves; the subsequent upsert identifies the new context. A newer delete wins over any older upsert. Fixtures are at `tests/fixtures/flightdeck-record-delta-v1.json`.

## Snapshot and handover

No cursor starts a snapshot with a committed workspace boundary B. B is read from a transactional workspace counter, never a sequence allocation. Snapshot scans a persisted current-record projection by `(family,id)` keyset. It is a convergent snapshot: rows may reflect writes after B. Snapshot changes use version B. After the last partition, the cursor switches to delta strictly after B; these deltas repair inserts, edits, moves and deletes racing with pagination. The client must complete that handover before claiming convergence. `snapshot_id` remains stable during paging. Only the terminal page lists all `partitions_complete`. Missing rows on any page never authorize deletion. Start a new authoritative generation and retire the old generation only after snapshot completion and handover; preserve unresolved commands independently.

Delta pages process at most 200 journal entries plus one metadata-only lookahead, including hidden entries, so empty pages may have `has_more:true`. Apply changes and cursor atomically, tolerate repeated pages, and yield between pages. A crash before commit replays the page. Transactions that allocate a position hold the workspace counter row lock until commit/rollback: a later writer cannot publish a higher committed position ahead of them. Rollback leaves no journal/projection writes. No journal pruning in v1. Progress cursors expire after seven days and only the latest 512 per workspace/viewer are retained. Evicted/expired cursors return reset_required. Empty delta polls reuse the supplied cursor and create no cursor row; each progress request also reclaims up to 64 expired cursor rows. Cancel in-flight pages on reset and apply only responses for the expected request cursor and local generation.

## Bounds and permissions

Limit 1..200 (default 200). Entire JSON response is at most 1,048,576 UTF-8 bytes. A single oversized row returns 413 `record_too_large` without advancing the cursor; never truncate canonical rows or silently skip them. Cursor size is capped. Cursor positions are server-owned and viewer/workspace/ACL-generation bound; never construct or mix them with legacy cursors.

Every page rechecks current membership and permission grants inside one database transaction. Changes to grants, group membership/edges, workspace membership, identity, scope/channel visibility or ownership invalidate the generation. Return 409 `{error:'reset_required',protocol_version:1,reset:{discard_authoritative:true,preserve_pending:true}}`. Client must immediately hide/discard this protocol's authoritative rows and restart without cursor; never keep revoked data visible while resnapshotting. Membership loss returns 403; purge/hide the workspace cache while preserving pending commands for explicit reconciliation. Grant expansion also resets so previously hidden records are included. An ACL reset never returns record data. Authorization is evaluated at the response transaction's database snapshot; later revocations take effect on the next request. Retention/restore or deployment incompatibility must invalidate generations, not reinterpret cursors.

Scope/channel records use current read grants; channel records require active scope/channel visibility. Tasks and task comments/assignments require task.read. Docs/files/audio use their read permission or channel.read. Messages/threads/folders use channel.read. Personal records are owner-only in v1. View states are viewer-only plus target read access. Shared personal records remain on their existing API until a separately negotiated extension. Directory and other unadvertised families retain their current API paths; do not advertise complete-workspace replacement.

## Indexed list reads

Existing message pagination retains its millisecond timestamp then ID ascending order, backed by an immutable UTC millisecond expression index. Both channel and channel/thread variants are indexed. Task channel lists now accept optional `state` and opaque `cursor`, with updated timestamp descending and ID ascending, at most 200 rows plus one lookahead. Task/doc comment lists accept opaque `cursor`, order full PostgreSQL creation timestamp then ID ascending and return `has_more` and `next_cursor`. Keep list cursors per exact endpoint/filter. The cursor carries the original SQL timestamp text to avoid losing microseconds. Existing callers without cursor retain first-page behavior.


## Parent invalidation and producer memory bounds

Deleting a task, document, or thread (soft or hard) invalidates the workspace generation in the same transaction, with constant producer work independent of dependent count. This explicit reset clears cached dependents without omission-based deletion or an unbounded tombstone fanout. Snapshot visibility also checks live parents for comments, task assignments and resource view states. Canonical `resource_type: document` view states use doc.read/channel.read, not only channel.read.

The journal/current projection store generated byte counts and small ownership context separately from canonical JSON. Each page reads at most limit+1 metadata rows, authorizes them, and fetches only visible canonical payloads that fit the cumulative response budget. Hidden payloads and later rows that cannot fit are not sent by PostgreSQL to the application. The isolated driver regression inserts 200 records of 900,000 bytes and asserts less than 1,150,000 bytes of total decoded query results for a visible page, and less than 150,000 bytes for a hidden page; exactly one large canonical payload is fetched for the visible page and none for the hidden page.
