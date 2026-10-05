# Canonical task assignment

Tasks accept zero or one assignee. Tower owns the primary identity in
`metadata.assigned_to_npub`; serialized `assigned_to_npub` and active assignment
rows represent that same identity. A null primary means unassigned.

Task creation, top-level primary edits, metadata edits, and the historical
zero-or-one `assigned_to_npubs` input all synchronize assignment rows within the
same transaction. More than one distinct submitted identity is rejected. An
assignee must resolve to a workspace actor. Partial metadata updates merge only
submitted fields onto the locked current task, so an unrelated edit cannot
replay a stale assignee.

`POST .../tasks/:id/assignments` replaces the previous actor, serializing on the
parent task row. A repeated assignment emits no new activity/event. Assignment
API writes increment the task row version. Assignment PATCH honors a supplied
row version; ordinary task patches retain their existing last-write behavior.
Task edit leases, permission gates and read-state ownership remain unchanged.
`DELETE .../assignments/:actorId` clears primary and relations only if that actor
is still assigned. Repeated or delayed deletion succeeds without clearing a
replacement assignee. Task activity advances for a changed assignment, so a new
assignee receives attention after an earlier read.

The database synchronizes relation rows whenever primary metadata is inserted
or edited. A parent-row-locking guard prevents new multiple active relation rows.
A partial unique index also enforces the rule where historical ambiguity permits
installing it. Tombstones retain historical assignment evidence and are delivered
through the existing record journal; deleting a former assignment rematerializes
its cached parent on both delta protocols.

## Repair and unresolved history

The idempotent `task_single_assignee_v1` startup migration:

- Keeps a valid explicit primary and tombstones every different active row.
- Materializes a missing relation for a valid primary.
- Honors explicit null by tombstoning leftover rows.
- Uses a sole active relation when primary metadata was absent.
- Preserves invalid primaries and multiple rows without an explicit primary.

Unresolved cases are reported by the read-only
`flightdeck_pg_task_assignment_ambiguities` view, including workspace, task,
primary identity and active actor IDs. They do not prevent service startup.
They require a product owner to choose an explicit primary (or explicit clear)
through the authorized task API. No actor is selected arbitrarily. Existing
unresolved relations remain historical exceptions until that decision; new
assignment writes still enforce a single actor. Re-running migration after
resolution installs the unique index when no multiple active rows remain.

Repair never advances task activity, task versions, leases, viewed watermarks,
read timestamps or device checkpoints. It emits canonical metadata/assignment
journal changes and refreshes only derived attention. Comment mention event
positions remain intact. Former assignees become neutral unless an independently
unread comment mentions them.

Inspect unresolved cases before and after activation, and retain evidence on the
authorized task or under ignored `tmp/docs/handoffs/`. Do not use live databases
for tests. The disposable attention suite seeds the preceding task/assignment
schema, verifies repair and delta delivery, ambiguous preservation, repeat
startup, reassignment, delayed deletion and concurrent metadata edits.
