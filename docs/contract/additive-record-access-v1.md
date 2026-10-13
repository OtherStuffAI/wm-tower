# Additive record access v1

Channel creation, initial grants, grant changes and group/workspace membership
changes preserve the ordinary record journal position, workspace epoch, v1 cursor
and v2 device checkpoint. Previously downloaded records remain local after access
loss. Tower authorizes every future request against current authority; a saved
cursor, snapshot or checkpoint is never an authorization proof.

This extends the existing [v1 pages](../design/flightdeck-record-delta-v1.md) and
[v2 device checkpoints](record-device-checkpoints-v2.md), without a new protocol
version or a separate network owner. Existing v1/v2 readers consume new historic
catchup rows through the same canonical `changes` array.

## Routes and fields

All routes remain under `/api/v4/flightdeck-pg/workspaces/:workspaceId`:

| Method / route | Contract |
| --- | --- |
| GET `record-sync?protocol_version=1&cursor=…&limit=200` | Existing actor-bound v1 continuation |
| GET `record-sync?protocol_version=2&client_id=…&cursor=…&limit=200` | Existing cache-bound v2 page |
| POST `record-sync/clients/:clientId?protocol_version=2` | Register; no implicit acknowledgement |
| GET `record-sync/clients/:clientId?protocol_version=2` | Read durable checkpoint, with current membership check |
| POST `record-sync/clients/:clientId/ack?protocol_version=2` | Body `{cursor,expected_revision}` after local atomic materialization |
| DELETE `record-sync/clients/:clientId?protocol_version=2` | Retire only the owned cache |

Page additions, optional for compatibility with older producers:

- `access_revision`: decimal authority observation version, separate from journal
  positions and device checkpoint CAS revisions. Its change does not require reset.
- `access_changes`: at most 50 `{family,resource_type,resource_id,status}` objects,
  where `resource_type` is `workspace`, `scope` or `channel`, and `status` is
  `granted` or `lost`. `resource_kind` is present for `resource_view_state` and is
  `task`, `document` or `thread`. Lost partitions were previously known to this
  reader; hidden resource identifiers and grant topology are not disclosed.
- `catchup`: null or `{family,resource_type,resource_id,resource_kind?}` identifying
  the targeted historic partition in this page.
- `retention_policy`: `retain_downloaded`.

Checkpoint/register/ack add `access_revision` and `retention_policy`. Discovery
`record_sync` adds `additive_access:true`, `targeted_catchup:true` and
`retention_policy:"retain_downloaded"`. The actor/workspace/client and exact
NIP-98 URL/method/body binding remain unchanged.

Access notifications count towards the page row budget. Both normal and catchup
scans limit candidate entries before permission filtering. The complete response,
including sidecars/access metadata, remains bounded by 200 entries and 1 MiB.
New clients use normal snapshots; established catchup keeps `mode:"delta"`,
`snapshot_complete:false` and `partitions_complete:[]`. These pages never signal a
workspace replacement or declare missing retained rows deleted.

## Independent history and authorization

Server-owned continuation stores the readable partition baseline, pending access
notifications, and historic catchup keysets independently of the ordinary journal
`after` position. When authority changes, compare current readable partitions to
that reader's baseline. Only gains with canonical history at/before its ordinary
position queue catchup. Empty channel birth has no such history: the existing
channel journal entry is the only content change.

Catchup uses current canonical rows from newly readable partitions, with a fixed
journal cutoff and ID keyset. Rows newer than that cutoff arrive through ordinary
delta. Each response advances either catchup or ordinary journal progress; historic
catchup never rewinds the latter. `has_more` drains outstanding notifications,
catchup and the subsequent ordinary delta through the existing pull loop. Retries
are idempotent under normal canonical upsert semantics. Catchup can pause ordinary
delivery while its bounded pages drain; it does not create another request stream.

Permissions are rechecked for every returned payload and its identity sidecars.
Authority writes increment the workspace clock's `access_revision` without changing
`epoch` or journal position. Repeatable-read scans acquire the clock shared lock
before returning; concurrent authority changes force a fresh-authority retry,
including cursorless v1 snapshots. Checkpoint operations lock the same clock before
checking current workspace membership. Group nesting follows stable group UUIDs;
cryptographic group identity rotation is not an implicit membership grant.

A channel revocation cancels unread catchup and filters future pages; it does not
invalidate checkpoints or prevent acknowledgement of a previously downloaded page.
Ack records local commit, not permission to fetch more content. Workspace membership
loss denies register/read/page/ack immediately. Device CAS and monotonic ordinary,
snapshot and catchup progress still prevent stale/racing acknowledgements.

## Retention and genuine deletion

Clients mark lost partitions read-only/stale/access-lost and retain their downloaded
rows, outbox, drafts, editor and navigation state. A channel may retain other readable
families; do not infer whole-channel loss from one family notification. Materialize
canonical changes, access metadata and cursor atomically through the existing worker
and Dexie path, then acknowledge v2. Never interpret filtering or snapshot omission
as deletion. Reject responses crossing actor/workspace/cache lease boundaries.

Real `operation:"delete"` records remain content deletion. Deleting a task, document
or thread now journals explicit dependent tombstones rather than resetting the
workspace epoch; restoration journals surviving dependents again. Delivery of these
identifier-only tombstones still requires current channel grants, and personalized
watermarks are only delivered to their owner. Permission loss emits no tombstones.

Repair errors use `{discard_authoritative:false,preserve_pending:true,
preserve_downloaded:true}`. Expired/damaged checkpoints and `history_pruned` require
an authorized replacement cursor/client while preserving downloads. Both v1 and v2
reject missing journal prefixes rather than silently skip them. New snapshots express
current authority, never retroactive purge. Identity/workspace binding changes and
incompatible restore remain genuine epoch-reset boundaries. Pending forbidden writes
stay visible for user resolution; avoid endless retries.

## Runtime upgrade and rollout

`additive-record-access-v1.sql` is applied to an existing record schema before startup
authority repairs, and again atomically with the record/checkpoint schema installation.
It replaces installed trigger functions, adds `access_revision` and canonical
`position`, and seeds pre-extension continuation baselines under authority/clock locks.
This also supports pre-v2 databases without device tables. Existing cursor UUIDs,
epochs, checkpoint cursors/CAS revisions and expiry timestamps remain intact.
Subsequent startups do not reseed existing baselines or renew expired tokens.

Tower-first rollout needs no negotiation: older clients ignore additive metadata and
apply canonical catchup upserts/deletes through existing v1/v2 logic. Browser retention
and access-status presentation must ship separately; an older client may still clear
its cache on exceptional repair or membership-loss errors. Routine permission changes
no longer produce those resets. Activate Tower first, verify installed functions and
healthy HTTP/FIPS endpoints, then activate clients and validate UI retention separately.

Isolated acceptance: `RECORD_TEST_PORT=<dedicated-port> bun test
./tests/flightdeck-additive-record-access.test.ts ./tests/flightdeck-record-delta.test.ts
./tests/flightdeck-record-checkpoints.test.ts` after loading `.env.example`. The suites
create/drop dedicated databases; they never write runtime workspaces.

## Workspace admission and linked storage

Every workspace member belongs to the system `Workspace` group. Its
`workspace.read` grant permits discovery/login. Membership does not create any
scope/channel content grants. Remove sharing at the explicit scope/channel
grant boundary when a member should see only a subset of the workspace.
Startup/bootstrap preserve explicit grant revocations, including the default
DMs scope grant. Existing owner/admin and other explicit grants remain intact.
Private typed storage metadata and bytes use the current linked channel ACL;
legacy uploader/group grants do not bypass a linked typed resource's boundary.
Previously authorized downloads and cursor continuity remain preserved.
