# Context Tree v1 — Tower source contract (WP1)

A scope contains any number of named component trees. Parentless rows are top
level. There is no tree record, component body, business status or special
reference. Tower stores structure and links; referenced content stays authoritative.
This is source implementation for review, not runtime activation.

## Transport and rows

Use existing NIP-98 authentication (including broker-signed requests), workspace
membership and Tower PG identity envelopes. Successful responses include
`identity` and `{capabilities:{read,manage}}`. Errors use the existing typed PG
`{error:string,code,status,identity}` envelope. Unreadable, missing, archived or
out-of-scope structure returns neutral `404 context_not_found`. Visible readers
without management get `403 permission_denied` for edits and delete preview.
Malformed requests return `400 validation_error`; stale row versions, cycles,
duplicate references and invalidated previews return `409` with a specific code.

`FlightDeckPgContextComponent` and `FlightDeckPgContextReference` in `src/types.ts`
are canonical transport types. Dates serialize as ISO strings; row versions and
sort orders are integers. `parent_id` and `deleted_at` are nullable. Reference
rows include **scope_id**, an additive refinement of the proposed shape needed
for composite foreign keys and scope-filtered sync. It is server-owned.

Readers use the existing scope browser visibility rule: `scope.read` **or**
`channel.read` on an active channel in that scope. All edits require that visibility
plus `scope.manage`. The actor capability describes structure only; it never grants
access to reference content. Archived scopes expose no context API view or editable
tree; persisted rows remain retained, and scope archival must clear caches in WP2.

## Routes and requests

Prefix: `/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/context`

| Method / suffix | Request | Payload |
| --- | --- | --- |
| GET `/components` | `limit`, `cursor` | `components`, `next_cursor` |
| POST `/components` | `{title,parent_id?,sort_order?}` | `component`, audit/outbox |
| PATCH `/components/{componentId}` | `{expected_row_version,title?,parent_id?,sort_order?}` | `component`, audit/outbox |
| GET `/components/{componentId}/references` | `limit`, `cursor` | direct `references`, `next_cursor` |
| POST `/components/{componentId}/references` | `{target_type,target,sort_order?}` | `reference`, audit/outbox |
| DELETE `/components/{componentId}/references/{referenceId}` | JSON `{expected_row_version}` | tombstoned `reference`, audit/outbox |
| GET `/components/{componentId}/delete-preview` | none | `preview` |
| POST `/components/{componentId}/delete` | `{confirmation_token}` | `deleted`, audit/outbox |

Unlink CAS is an explicit refinement of the proposed DELETE route: send a signed
JSON body, just as other typed PG writes bind the body to NIP-98. No edit lease is
required for these small whole-row CAS commands. Lists use current-view keyset
paging, default 50, maximum 200; follow `next_cursor` until null. Cursors bind to
workspace/scope/operation/component. Concurrent edits can change a paginated view;
WP2 owns snapshot/delta recovery. Ordering is `(sort_order,id)`, interpreted within
siblings or within one component's links. Lists are flat; derive layout from parents.
Creates append to siblings unless order supplied. Reparent appends to destination
siblings unless explicit order supplied, updates only the moved root, and retains
all descendants/links. Equal explicit orders use UUID as deterministic tie breaker.
Only same-scope/same-workspace parenting is supported. Unknown fields are rejected.
Titles are trimmed nonempty strings of at most 256 characters.

Examples (substitute real UUIDs and sign each exact URL/method/body):

```json
{"title":"API","parent_id":null}
```

```json
{"expected_row_version":1,"parent_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}
```

```json
{"target_type":"doc","target":{"record_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}}
```

```json
{"target_type":"artifact","target":{"origin":"https://example.com","project":"Suite","artifact":"Design","page":"index.html","version_policy":"latest"}}
```

Typed targets are `doc|file|task` with exactly `{record_id}` or `artifact` with
exactly `{origin,project,artifact,page:"index.html",version_policy:"latest"}`.
`doc` is Tower's existing record/event name; map to `document` when an existing
client record-link/opener expects that name. No document text is copied.
Record targets must be active and accessible in the same workspace, including
other scopes. Documents/files reuse existing `doc.read|channel.read` and
`file.read|channel.read`; tasks use `task.read`. Target scope/channel must be active.
Attach never grants permissions. Duplicate canonical targets within a component
return `409 duplicate_reference`; other components can share them. Tombstoned
links may be reattached with a new UUID.

Reference lists add a nonpersisted `resolution`: available records return
`{status:"available",record_id,title}`; inaccessible/deleted targets return only
`{status:"unavailable"}`. Stored link identifiers are visible to structure readers,
but private target metadata/content is never returned. Recheck target access when
opening through its normal typed route; no cached resolution grants access.
Artifacts return `{status:"external"}` without fetching their origin. Origins must
be HTTP(S) without credentials/path/query/fragment and are normalized using URL
origin. Project/artifact use 1–128 ASCII letters, digits, underscore or hyphen.
This is a safe descriptor, not an access claim or proxy URL. WApp authentication,
verified follow-latest navigation and resolved-version evidence belong to WP4/WP5.

## Concurrency, deletion and events

Every context operation takes a scope-row `FOR UPDATE` transaction lock at READ
COMMITTED. Edits, link changes, delete preview and deletion all coordinate on it;
existing scope archival updates the same row. Opposing concurrent moves see the
preceding committed hierarchy and cannot form a cycle. Direct SQL writes are not
an agent API and must not bypass the service's hierarchy protocol.

Preview returns `component_id,component_count,descendant_count,reference_count,
confirmation_token`. The SHA-256 token binds workspace/scope/root and **every
persisted active subtree and reference row**, ordered by ID. It is not permission
or an authorization token. Delete repeats visibility/management/hierarchy checks
under the same lock. Any rename, move, reorder, link replacement or version change
invalidates it, even if counts are unchanged: `409 delete_preview_changed` requires
a new preview and human confirmation. No offline destructive queue is implied.

Deletion tombstones all active descendants/links in one transaction, increments
versions, and writes audit/outbox in that transaction. A failed audit/event insert
rolls the data back. Referenced tasks/documents/files/artifacts are untouched; there
are no FKs/cascades to target tables. Repeat delete after completion returns 404.

Mutations return `audit:{event_id,operation,actor_npub}`, `outbox:[{id,row_version}]`
and `mutation_id`. Outbox event names and entity types are
`context_component.created|updated|deleted` / `context_component` and
`context_reference.created|deleted` / `context_reference`. Each affected row gets
one event with existing PG fields `workspace_id,scope_id,channel_id:null,actor_id,
entity_id,entity_row_version,operation`. Payload is only
`{schema_version:1,mutation_id,scope_id,component_id}`. It intentionally excludes
target metadata. Event visibility uses the scope visibility rule even for workspace
subscribers. Refetch routes point to components or the affected component's direct
references; a deleted component's reference route returns 404.

**WP2 required:** register both record families in snapshot/delta/schema recovery,
filter by scope visibility, preserve tombstones, atomically materialize subtree
mutations (shared mutation UUID), clear archived/revoked scope caches, and hydrate
reference resolution through typed ACL-checked reads. WP1 does not register these
families in `/records` or alter Flight Deck cache/sync. Consumers must not treat
outbox hints or stored target identifiers as readable target metadata.

## Publication and validation

OpenAPI includes all eight operations and request/row schemas. Existing fixture
publication paths in `src/types.ts` enumerate `fixtures/flightdeck-pg/context-*.json`.
Fixtures use generic records and illustrative tokens, never operational identities.
Bootstrap `001_init.sql` embeds `context-tree-v1.sql` byte-for-byte; runtime schema
installs that same additive SQL on startup. No live migration was performed.

Focused validation runs against an explicitly opted-in disposable PostgreSQL
fixture on a nonruntime port. The test creates and drops a unique database:

```sh
set -a; . ./.env.example; set +a
CONTEXT_TEST_PORT=<disposable-postgres-port> bun test tests/flightdeck-pg-context-tree.test.ts
```

Runtime rebuild/migration, health and authenticated live smoke validation are
separate WP6 activation work under explicit lifecycle authorization. Board scenes,
Project-defn v4 and all image assets are unchanged.

## WP2 canonical record recovery

`context_component` and `context_reference` are registered in the canonical PG
record-family registry. `context-tree-sync-v1.sql` installs/backfills capture
triggers after the WP1 tables and existing record journal functions. Bootstrap
and runtime schema use the same additive SQL. First installation rotates record
cursor epochs so existing caches negotiate a complete replacement snapshot;
repeated installation preserves epochs/cursors.

Both families use bounded `/records` snapshot/delta paging and explicit null-row
`delete` tombstones. Scope visibility uses the same WP1 scope/channel grant rule,
including for deleted rows; archived/inaccessible scopes cannot disclose structure.
Permission changes and archival invalidate cursors through the existing epoch
protocol. Reference payloads are canonical stored rows, without title/resolution;
use the existing typed reference read to recheck target ACLs. Outbox events remain
WP1 mutation/scope/component hints and do not carry record/target content.

Flight Deck accumulates context authority across pages, then publishes component
and reference projections together at terminal catchup. This is stronger than
per-event/mutation batching: split pages, reconnect and subtree tombstones never
publish a partial hierarchy. Authority resets hide context before replacement.
See Flight Deck `docs/design/context-tree-cache.md` for WP3/4 service entrypoints.
Source/disposable-fixture verification does not activate the shared runtime;
activation and live convergence checks remain WP6.
