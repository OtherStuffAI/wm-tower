# Personal pins v1

Personal thread, task, document and channel selections synchronize for the authenticated actor in one
workspace. Tower owns state; Ambulando owns its Dexie projection and UI. This
adds a typed operation rather than extending unrelated resource view states,
notification preferences, personal agent settings or WApp preferences.

`PUT /api/v4/flightdeck-pg/workspaces/:workspaceId/me/pins/:resourceType/:resourceId`
(`resourceType` is `thread`, `task`, `document` or `channel`). The thread checkpoint route
`PUT .../me/thread-pins/:threadId` remains an alias. The typed route
accepts only `pinned`, `expected_row_version`, `mutation_id`, optional
`import_only`, and optional import-only `pinned_at`. The NIP-98 signer resolves
through existing workspace session mapping to the canonical actor. Membership
is required; caller-supplied actor/reader fields are rejected. Thread pins require channel read access; non-human thread readers also require
participation. Task and document pins require the existing `task.read` or
`doc.read` channel permission. Pinning acquires no edit lease and changes no
resource, assignment, document body or read position. Unpin
can remove unavailable targets, without granting access or returning content.

The acknowledgement is `identity` plus `pin`: a stable row UUID, workspace,
actor, resource type/ID, optional thread ID, canonical channel/root IDs, pinned boolean, pinned timestamp,
per-thread row version, and updated timestamp. Personal rows contain no titles.
Unavailable legacy imports preserve only the UUID selection, without metadata.
An import accepts no channel/root fields and cannot confer read authority.

Each actor/workspace/type/resource pair has its own CAS version. Absent means version
0. Successful operations advance the version; unpin retains a permanent false
row. Same-thread concurrent writes at one base version yield one winner and one
`409 thread_pin_conflict`. Independent threads never overwrite one another.
Exact mutation-ID retries replay the original acknowledgement, even after later
changes; changing a mutation's payload yields `409 mutation_id_reused`. The client
must keep immutable requests and must not silently rebase a conflict. Clock lock
ordering matches record/lifecycle writers; selection, journal and private SSE
hint commit together. Pins never advance thread activity or read watermarks.

Migration uses `import_only: true`, `pinned: true`, version 0. It inserts only
when that pair has never been seen. An existing pin or unpin tombstone wins, even
on repeated migration from a stale device. The same actor can import disjoint
legacy selections from multiple devices. New explicit pins can repin tombstones
at their current version. Tombstones and mutation receipts are not pruned.

Canonical `personal_pin` rows, including false tombstones, use existing bounded
record snapshots/deltas and actor-only visibility. SSE hints are personal to the
actor, excluded from shared workspace and managed agent audiences. No new stream,
poller, authority epoch or read receipt is introduced. Consumers must register
the additive record family and keep backend/app/workspace/actor partitions.

Ambulando queues fixed requests in its workspace Dexie database, projects pending
intent locally, and flushes via TowerSyncService. Migration preparation and
acknowledgements run in the existing materialization worker. Temporary failures
retain the queue for existing synchronization/reload retries. Permanent failures
or CAS conflicts discard that request and dependent same-thread requests, report
a visible error and recover canonical state. The user can choose a new mutation
after recovery. A stale pin retry cannot revive a newer unpin; an intentional
new explicit pin can. Browser data clearing discards unsent local changes only.


## Upgrade and client presentation

The thread checkpoint's table names remain for storage compatibility. The
idempotent `personal-pins-v1.sql` migration adds typed resource identity, retains
row UUIDs/versions and mutation receipts, and leaves immutable historical
`thread_pin` journal entries readable as a legacy alias. Current rows recover as
`personal_pin`; the migration does not reset cursor epochs or read watermarks.
Only thread selections have legacy imports. New task/document operations are
explicit user intentions and use the same per-resource CAS/tombstones.

The unified list uses type/ID keys so equal UUIDs in different resource tables
never collide. Canonical Dexie task/document titles and personalized attention
update through liveQuery. Missing/deleted/inaccessible resources show a neutral
typed unavailable label and remain removable. Opening tasks/documents delegates
to the existing internal-reference navigation, preserving departure/draft,
normal view/read and edit-lease behavior. Pin controls on Inbox cards and detail
headers mutate only the personal outbox, including while a task/document is open.

Membership revocation denies reads/writes but retains private selections and
tombstones. Rejoining as the same canonical actor cannot revive stale pins.
Only deleting the workspace or canonical actor cascades this personal state;
those are identity lifetime boundaries, rather than tombstone expiry.

## Channel selections

Channel pins use the same typed PUT with `resourceType=channel` and require the
existing `channel.read` authorization for an active channel in this workspace.
No thread participation requirement applies to channel selections. The actor
cannot supply routing metadata: Tower returns canonical `channel_id=resource_id`,
`scope_id` and `root_record_id=resource_id`, with `thread_id=null`. Titles come
from authorized canonical channel rows. New mutations also capture scope metadata
for existing types; historical rows and immutable acknowledgements may omit it
or have null scope. Consumers must tolerate that and resolve canonical parents.

`channel-pins-v1.sql` runs after the existing personal-pin migration on fresh
and upgraded databases. It adds nullable scope metadata and replaces the old
type constraint without rewriting rows, versions, receipts, journals or epochs.
Repeat application is safe. No channel imports are accepted. Missing/archived
channels return the existing `404 thread_not_found` error; forbidden targets
return `403 thread_pin_target_forbidden`. Unpin requires membership and CAS but
no target access, preserving removable unavailable selections and metadata.

Channel unread presentation uses existing authorized channel/thread read state;
pinning changes no read watermark, channel activity, notification or lease.
All four types use independent type/UUID keys, private `personal_pin` recovery
and actor-only SSE. Ambulando must extend its existing outbox/projection and
TowerSyncService rather than add direct component networking or a new poller.
Source delivery requires a later approved Tower rebuild/restart and authenticated
smoke checks before the frontend can rely on the new type in the running API.

## Personal ordering v1

`POST .../workspaces/:workspaceId/me/pin-order` accepts a strict immutable body:

```json
{"resource_type":"channel","resource_id":"UUID","expected_row_version":3,"before":{"resource_type":"thread","resource_id":"UUID","expected_row_version":2},"mutation_id":"UUID"}
```

`before: null` means move to end. Target and anchor must be currently pinned
rows belonging to the authenticated workspace actor. Both versions are positive
CAS integers. A self-anchor or extra fields returns `400 invalid_pin_order`.
Absent/unpinned targets or anchors and stale versions return `409 pin_order_conflict`.
Moving an unavailable resource selection needs membership, without reading its
resource body or granting target access. The workspace fixes the app identity; caller app hints cannot switch the
authoritative workspace app or actor partition.

The response is `{identity, pins}` with all current active canonical pin rows in
result order. Each row has optional nullable `order_position`. Missing and null
positions sort first, by `pinned_at DESC` then ASCII `resource_type:resource_id`
ascending; positioned rows follow, by position ascending and the same typed key.
This retains legacy timestamp ordering. New selections and explicit repins use
null, appearing at the top; an already-pinned `pinned:true` retains its position.

A move normalizes all current active pins to contiguous integers, changing only
positions that differ. Changed rows advance their existing row version and
updated timestamp. The existing capture trigger delivers the complete changes
as actor-private `personal_pin` record deltas; one actor-only SSE hint wakes sync.
The transaction shares the workspace record clock with pin/unpin and lifecycle
writes. Selection booleans, timestamps, routing, resource activity, read state,
leases and tombstones remain unchanged. Concurrent additions are included and
never lost. A concurrent move or unpin may invalidate versions: clients recover
and offer a new user action, without silently rebasing the immutable request.

The existing actor/workspace mutation receipt namespace includes moves, with an
operation-tagged hash. Exact retries replay the original pins acknowledgement
even after later unpins; changed payload or cross-operation ID reuse returns
`409 mutation_id_reused`. Historical acknowledgements never overwrite current
Tower state. Clients materialize them monotonically by row version, queue moves
through the existing private outbox/TowerSyncService, and discard conflicted
moves and dependent requests visibly before canonical recovery. Keep backend,
app, workspace and canonical actor partitions. No UI networking or new poller.

`personal-pin-order-v1.sql` runs after channel pins in bootstrap and runtime
upgrade. It adds one nullable checked integer without rewriting rows, versions,
receipts, journal history or cursor epochs. Old snapshots/receipts may omit the
field; consumers treat it as null. Applying the migration repeatedly is safe.
Authenticated HTTP `record-sync` pages (v1 and v2) advertise
`personal_pin_order_version: 1`, independent of old row bodies. Clients should
use that response capability for old-server negotiation; absence means support
is unknown/unavailable. Canonical history and content hashes remain untouched.

The frontend integration and coordinated runtime activation are separate from
source validation; the supervising manager owns activation and live smoke checks.
