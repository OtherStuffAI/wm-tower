# Personal thread pins v1

Personal thread selections synchronize for the authenticated actor in one
workspace. Tower owns state; Ambulando owns its Dexie projection and UI. This
adds a typed operation rather than extending unrelated resource view states,
notification preferences, personal agent settings or WApp preferences.

`PUT /api/v4/flightdeck-pg/workspaces/:workspaceId/me/thread-pins/:threadId`
accepts only `pinned`, `expected_row_version`, `mutation_id`, optional
`import_only`, and optional import-only `pinned_at`. The NIP-98 signer resolves
through existing workspace session mapping to the canonical actor. Membership
is required; caller-supplied actor/reader fields are rejected. Human pins require
channel read access; other actor kinds also require thread participation. Unpin
can remove unavailable targets, without granting access or returning content.

The acknowledgement is `identity` plus `pin`: a stable row UUID, workspace,
actor, thread, canonical channel/root IDs, pinned boolean, pinned timestamp,
per-thread row version, and updated timestamp. Personal rows contain no titles.
Unavailable legacy imports preserve only the UUID selection, without metadata.
An import accepts no channel/root fields and cannot confer read authority.

Each actor/workspace/thread pair has its own CAS version. Absent means version
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

Canonical `thread_pin` rows, including false tombstones, use existing bounded
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
