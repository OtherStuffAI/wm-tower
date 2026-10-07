# Shared organisation data and static napplets v1

Tower stores workspace-scoped catalogue definitions, typed records, audit history,
immutable static bundle versions and installations in Postgres. Humans and agents
use the same NIP-98 typed routes under
`/api/v4/flightdeck-pg/workspaces/:workspaceId/org-data`.
Flight Deck uses its existing TowerSyncService network owner; napplets receive
only a validated projection through the host bridge. This is a Wingman v1
contract; NIP-5D conformance has not been established.

## Authority

Every operation requires the exact Flight Deck app identity, an existing actor
and workspace membership, `workspace.read` and `org_data.read`. Membership roles
alone grant no org-data authority. Canonical actor/group permission grants
provide these dedicated workspace permissions:

| Permission | Operation |
| --- | --- |
| `org_data.read` | Read permitted catalogue, records and installed bundles |
| `org_data.write` | Create, replace and delete permitted records |
| `org_data.schema` | Create/validate definitions, bootstrap defaults, read audit |
| `napplet.publish` | Publish immutable bundle versions |
| `napplet.install` | Install/upgrade a published bundle |

The existing Admins group gets these defaults; People gets read only. Agents get
no default org-data authority. Existing revoked grants are not re-created by
runtime schema reconciliation. New workspaces use the same defaults.

A definition's `access.read` and `access.write` select `members` (actors holding
the appropriate dedicated permission) or `admins` (also requires
`org_data.schema`). A schema administrator still needs read/write permissions
for record operations. Hiding frontend actions is only a convenience.

`GET /permissions` lists direct actor grants. `POST /permissions` takes
`actor_id`, `permissions` and `expected_permissions`; the latter is a comparison
against current direct grants, with 409 on drift. Only a **human** holding
`workspace.manage` may use these routes. They never add membership, modify
ordinary workspace/group authority or let an agent self-escalate. Group grants
remain subject to the normal workspace administration boundary. A targeted
payload-free invalidation reaches an actor whose direct read permission was
revoked so the open host can reauthorize and clear its projection.

## Definitions and records

`GET /catalogue` returns permitted types and installation metadata.
`POST /bootstrap` creates only missing default definitions: teams, people and
holidays. Existing definitions and records are preserved.

`POST /types` creates a definition with `key`, `label`, `fields` and `access`.
`PATCH /types/:typeKey` requires `expected_revision`. Keys are stable lowercase
identifiers, up to 64 characters. A catalogue has at most 200 types, each with
at most 64 fields. Fields have a key, label, type and optional `required` flag.
Record references also name `target_type`.

Supported field types are `text`, finite `number`, `boolean`, calendar `date`,
`record_ref`, `actor_ref`, `nostr_ref` and `workspace_ref`. Values contain only
schema-declared scalar fields, at most 64 KiB. Required values cannot be empty.
Relationships are typed fields, not SQL/table joins.

`GET /types/:typeKey/records?limit=100&cursor=<UUID>` returns keyset pages, at
most 500 rows, with `next_cursor` and `has_more`. `POST` on that collection
creates a record; `PATCH /:recordId` replaces its complete `values` with a
required `expected_revision`. `DELETE /:recordId` also requires that revision
in its JSON body. A stale revision returns `409 revision_conflict`. Definitions
and records each start at revision 1.

Schema updates validate all existing values. Removing/changing existing field
contracts is rejected with `destructive_schema_change`; adding a required field
fails if any existing record is missing it. Workspace transaction locking
serializes schema changes, reference checks, writes and deletion. An actively
referenced record cannot be deleted (`409 record_referenced`). Failed changes
roll back records, audit and invalidations together.

References validate existing readable target records in the same workspace.
Actor/Nostr references require an existing workspace member, and both identities
must match when supplied together. Workspace references support the current
visible workspace only. References never grant membership or access. A read
redacts references to a restricted target type or removed member to null.

Default people fields are name, job title (`title`), team, manager, optional
actor and Nostr identity. Manager cycles are rejected. Holidays reference a
person, calendar start/end dates and display status; inverted dates are rejected.
The defaults have no leave reasons or approval workflow.

`GET /snapshot` returns an atomic complete authorised snapshot, including
permitted records, types, installations and only referenced member identities.
It fails above 10,000 records instead of silently truncating. Use paginated
record routes for larger datasets. Schema administrators also receive the 50
latest audit summaries. `GET /history` paginates detailed before/after changes;
ordinary readers cannot inspect historical values.

## Static bundle storage and installation

`POST /napplets/bundles` accepts `key`, positive integer `version`, `title`,
`bridge_version:1`, `capabilities` and UTF-8 `html` (up to 512 KiB). Scripts and
styles must be inline. Tower computes SHA-256 and stores an immutable version
in `flightdeck_pg_napplet_bundles`; reusing a version returns 409. No separate
server, DB credentials, private key, arbitrary remote URL or table join exists
in this path. `GET /napplets/bundles` lists version metadata.

`POST /napplets/installations/:bundleKey` takes `version` and
`expected_revision` (0 for first install). It binds the workspace installation
to that exact stored version and advances the installation revision. The
catalogue's Static napplets section can publish, install and launch a bundle.
Installed launchers are also available through Toolbox after the authorised
catalogue read. Built-in catalogue/people/chart/holiday launchers ship by default.

Capabilities are the closed set `org_data.read`, `org_data.write`,
`org_data.schema`, `profile.open`, `dm.open`. They restrict the host bridge and
never grant Tower permissions. The host always prepends its own CSP before the
published HTML and loads it in an opaque-origin `allow-scripts` sandbox.
Connections, forms, objects, frames and external assets are denied; image data
URLs can represent self-contained artwork. Publisher HTML never gets signing
state or the parent DOM/storage.

## Agent usage

`bun src/scripts/org-data.ts --tower <URL> --workspace <UUID> --app-npub <NPUB>
--path snapshot` uses the session's `WINGMAN_BROKER_URL`/`WINGMAN_URL`,
`SESSION_ID` and `WINGMAN_CAPABILITY`. Add `--method POST|PATCH|DELETE` and
`--body-file <JSON>` for a permitted mutation. The client requests NIP-98 from
`/api/mcp/capabilities/nip98` with the exact target, method and SHA-256 body hash;
redirects are denied. It accepts no private key and cannot expand its broker
scope. Tower independently checks every grant. A capability denial requires a
manager-issued scoped capability, never a raw-key fallback.

For example, discover `snapshot`, then PATCH
`types/people/records/<id>` with `{"expected_revision":1,"values":{"name":"Alex",
"title":"Lead"}}`, supplying all retained values. Subsequent catalogue, people,
chart and holiday reads share that persisted person ID.

## Activation and validation

Source tests use disposable Postgres and signed in-process HTTP routes.
Flight Deck browser fixtures exercise the real sync service, worker, Dexie,
liveQuery, sandbox and native modal, but do not establish live credentials or
production activation. The manager must activate the Tower source/schema through
its configured managed Docker lifecycle and the Flight Deck build through its
registered app runner, then run authenticated human/agent edits, reload all
shared views, test profile/DM and deny foreign workspaces and references.
