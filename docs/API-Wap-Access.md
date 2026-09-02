# WApp Tower Database Access

## Purpose

WApps need a generic way to use Tower-managed Postgres without requiring a Tower code change for every WApp.

The desired model is:

```txt
WApp frontend
  -> WApp backend API
    -> Tower generic WApp DB API
      -> Tower-managed Postgres schema/tables
    -> Autopilot for lifecycle, runtime env, pipelines, and webhooks
```

The WApp backend does not connect directly to Postgres. Browsers do not connect directly to Postgres. Tower keeps database credentials internal and exposes a generic API for WApp namespace provisioning, migrations, constrained queries, and CRUD.

## Locked Decisions

- Autopilot will provide the WApp private key to the app process as `APP_NSEC`.
- Tower stores/registers the corresponding `app_npub`, not the app private key.
- The WApp backend signs Tower migration and CRUD requests with `APP_NSEC` using NIP-98.
- Tower validates that the NIP-98 signer is the registered app identity for the target workspace/app namespace.
- Tower owns the Postgres connection and executes approved migration/query/CRUD operations internally.
- A WApp gets one database namespace per `(workspace_owner_npub, app_npub)` installation.
- The app identity in Tower is `app_npub`. There is no separate Tower-side app installation id required for namespace ownership.
- Same workspace plus same `app_npub` means the same WApp instance and the same DB namespace.
- Same `app_npub` in different workspaces means different WApp instances and different DB namespaces.
- User-level authorization remains in the WApp backend. The DB-to-app boundary is controlled by the app key.
- Agents are treated as users/actors validated through NIP-98 when calling WApp APIs. Agents should not bypass the WApp backend and call the generic DB API directly for normal app work.

## Goals

- Let WApps use relational Postgres tables instead of only local SQLite or generic JSON rows.
- Keep WApp domain APIs in the WApp backend, not Tower.
- Avoid redeploying Tower when adding a WApp-specific data model.
- Avoid issuing broad or direct database credentials to WApps.
- Support WApps that have no signed-in Nostr user yet, including public/read-only app experiences.
- Let Autopilot manage WApp lifecycle and setup while Tower remains the authority for app identity and database access.
- Make WApp database setup repeatable through migrations owned by the WApp.

## Non-Goals

- Do not expose arbitrary database superuser access to WApps.
- Do not require Tower to know every WApp table or business entity.
- Do not put WApp business data into Flight Deck PG tables unless the data is actually Flight Deck workspace data.
- Do not let Autopilot or agents bypass the WApp API for normal app operations.
- Do not make browser clients connect directly to Postgres.
- Do not hand raw Postgres connection strings to WApp backends in the default runtime path.

## Existing Tower Pieces

Tower already has app registration and app-scoped JSONB row storage:

- `workspace_apps`
- `workspace_app_schema_manifests`
- `workspace_app_schema_group_payloads`
- `workspace_app_rows`
- `/api/v4/workspaces/:workspaceOwnerNpub/apps`
- `/api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/:collection/rows`

The `workspace_app_rows` API remains useful for simple WApps. It is not enough for WApps with relational models, queues, reporting, uniqueness constraints, and migrations. Kindling is the immediate reference case: companies, sources, segments, work queues, ranking runs, outreach drafts, pipeline runs, scheduler locks, and settings should be first-class relational tables in a WApp-owned namespace.

## Identity Model

Each WApp installation has:

- `app_id`: Autopilot/WApp registry identity.
- `app_npub`: public Nostr identity for the WApp.
- `APP_NSEC`: private key injected into the app process by Autopilot.
- `workspace_owner_npub`: Tower workspace that owns or installed the WApp.
- `schema_name`: deterministic Postgres schema name owned by the WApp installation.

The WApp backend signs all Tower WApp DB requests with `APP_NSEC`. Tower verifies the NIP-98 event and checks that the signer is registered as `app_npub` for the target workspace/app namespace.

Tower namespace identity is:

```txt
workspace + app_npub
```

Autopilot may have its own app installation id for process/runtime bookkeeping, and a WApp marketplace or GitHub source may have a template/package id, but Tower database ownership is keyed by the workspace and app npub.

This supports shared development and environment separation:

- two developers using the same `APP_NSEC` against the same WApp Tower workspace share the same WApp instance and DB namespace;
- the same app package installed with a different generated app key in the same workspace gets a different app npub and therefore a separate namespace;
- the same app npub used in a different workspace gets a separate namespace because workspace ownership differs;
- dev, staging, and live can be separated by different WApp Tower workspaces, different app npubs, or both.

The app key is the right owner for infrastructure operations:

- provision namespace;
- run migrations;
- read and write app-public data;
- perform scheduled/background jobs;
- receive and persist Autopilot webhook callbacks;
- expose public WApp views that do not require a Nostr login.

The app key must not silently impersonate users. User-attributed or user-private actions are enforced by the WApp backend and, where needed, represented explicitly in row data such as `created_by_npub`, `updated_by_npub`, or domain-specific ownership fields.

## Namespace Model

Tower should allocate one schema per `(workspace_owner_npub, app_npub)` pair.

Preferred shape:

```txt
wapp_<app_slug>_<short_hash>
```

Examples:

```txt
wapp_kindling_a13f92
wapp_crm_d93a11
```

Tower should persist the namespace mapping. WApps should not guess schema names. All generic DB APIs should accept workspace/app identity and table names, not raw schema-qualified table paths.

## Tower API Requirements

Tower should expose one generic WApp database API. Route shape can reuse the existing app route prefix or use a dedicated prefix. The examples below use the existing workspace/app hierarchy.

Current Tower v1 implementation notes:

- namespace mappings persist in `workspace_app_db_namespaces` keyed by `(workspace_owner_npub, app_npub)`;
- descriptor/provision accept app, Tower admin, or Tower service NIP-98 signers;
- migrations, CRUD, and query require the NIP-98 signer to match the registered `app_npub`;
- migration SQL is limited to an allowlisted DDL subset and functions/triggers are deferred;
- CRUD/query table and column inputs are safe identifiers only and never schema-qualified names;
- direct Postgres URLs, arbitrary SQL query execution, named queries, billing measurement, destructive namespace cleanup, and Kindling-specific migration are outside this v1 slice.

### Descriptor

```txt
GET /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/descriptor
Authorization: Nostr <app-signed-or-admin-user-signed-nip98>
```

Returns the allocated namespace and supported operations.

```json
{
  "workspace_owner_npub": "npub1...",
  "app_npub": "npub1...",
  "schema_name": "wapp_kindling_a13f92",
  "capabilities": {
    "migrations": true,
    "crud": true,
    "query": true,
    "public_app_data": true
  },
  "limits": {
    "max_tables": 100,
    "max_columns_per_table": 100,
    "max_query_limit": 500,
    "statement_timeout_ms": 30000
  }
}
```

### Provision Namespace

```txt
POST /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/provision
Authorization: Nostr <app-signed-or-admin-user-signed-nip98>
Content-Type: application/json
```

Creates the namespace mapping and app schema if they do not exist. This does not run WApp migrations.

```json
{
  "app_slug": "kindling"
}
```

### Run Migrations

```txt
POST /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/migrations
Authorization: Nostr <app-signed-nip98>
Content-Type: application/json
```

The WApp backend sends ordered migration files or one migration at a time. The request is signed by the app key. Tower validates that the app key owns the namespace, obtains a migration lock, validates the SQL, executes it internally, and records migration history.

```json
{
  "migrations": [
    {
      "version": "001_init",
      "checksum": "sha256:...",
      "sql": "CREATE TABLE companies (...);"
    }
  ]
}
```

Tower should maintain a migration table inside the app schema, for example:

```sql
CREATE TABLE IF NOT EXISTS <schema>.schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

Migration SQL must be constrained:

- only operate inside the allocated app schema;
- no `CREATE EXTENSION`;
- no `CREATE DATABASE`, `DROP DATABASE`, `CREATE ROLE`, `ALTER ROLE`, or role grants;
- no `DROP SCHEMA`;
- no cross-schema table access except explicitly allowed built-ins;
- no `CREATE TABLE ... AS SELECT`, `CREATE TABLE ... LIKE`, inherited tables, partitions, functions, triggers, or arbitrary SQL;
- foreign-key `REFERENCES` targets must be schema-qualified to the allocated app schema to avoid `search_path` binding to Tower/public tables;
- WApp migrations must not create, alter, index, drop, or otherwise target Tower-managed `schema_migrations`;
- statement timeout enforced;
- migration lock per app namespace;
- append-only migration history unless an explicit repair/admin flow is added.

Allowed DDL should initially include:

- `CREATE TABLE`;
- `ALTER TABLE`;
- `CREATE INDEX`;
- `DROP INDEX`;
- `CREATE SEQUENCE`;
- `ALTER SEQUENCE`;
- constrained `DROP TABLE` inside the app schema.

Whether functions/triggers are allowed is still a security decision. Recommendation: defer functions/triggers until a concrete WApp needs them.

### Migration State

```txt
GET /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/migrations
Authorization: Nostr <app-signed-or-admin-user-signed-nip98>
```

Returns applied migrations, pending state if supplied by the WApp, schema name, and the last migration error if Tower records one.

### Generic CRUD

```txt
POST   /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows
GET    /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows
GET    /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows/:id
PATCH  /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows/:id
DELETE /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/rows/:id
Authorization: Nostr <app-signed-nip98>
```

Tower validates:

- signer is the registered app key;
- app namespace exists;
- `:table` is a safe table identifier;
- the resolved table is inside the app schema;
- payload matches supported CRUD/query shape;
- operation does not reference arbitrary SQL or schema-qualified names.

Create request:

```json
{
  "id": "company_123",
  "data": {
    "name": "North HVAC",
    "status": "queued",
    "profile": {}
  }
}
```

Patch request:

```json
{
  "set": {
    "status": "complete",
    "updated_at": "2026-06-19T00:00:00.000Z"
  }
}
```

Tower should support primitive column values and JSON values. It should not accept arbitrary SQL expressions in CRUD payloads.

### Supported Query Shape

The list endpoint should support constrained JSON queries. Arbitrary SQL query execution should not be part of the first version.

Supported request:

```txt
POST /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/tables/:table/query
Authorization: Nostr <app-signed-nip98>
Content-Type: application/json
```

```json
{
  "select": ["id", "name", "status", "updated_at"],
  "where": {
    "status": { "eq": "queued" },
    "updated_at": { "gte": "2026-06-01T00:00:00.000Z" }
  },
  "order": [
    { "field": "updated_at", "dir": "desc" }
  ],
  "limit": 100,
  "offset": 0
}
```

Initial supported operators:

- `eq`
- `neq`
- `lt`
- `lte`
- `gt`
- `gte`
- `in`
- `contains` for JSONB containment
- `is_null`

Initial supported ordering:

- one or more field names;
- `asc` or `desc`;
- no raw expressions.

Initial unsupported query features:

- arbitrary SQL;
- joins;
- subqueries;
- cross-table reads;
- aggregate functions;
- full-text search;
- user-supplied functions/operators.

If Kindling or another WApp needs joins or reporting, prefer adding named-query support later. Named queries would be registered by app-signed migrations or metadata and executed by name with validated parameters.

## Public WApps

A WApp can serve public data without requiring every visitor to log in with Nostr.

For public pages:

- browser calls the WApp backend without Nostr auth;
- WApp backend reads app-public tables by signing Tower DB requests with `APP_NSEC`;
- Tower sees the database access as app-owned infrastructure, not as a user action.

For mutations:

- public mutation rules are WApp-specific;
- the WApp may allow anonymous writes to limited domain APIs, such as waitlist submissions;
- the WApp backend signs the corresponding Tower write as the app;
- records should mark anonymous or app-created provenance explicitly;
- user-attributed private data should require user auth at the WApp API layer.

## Workspace And Billing Model

This is the main unresolved product model.

A person has an `npub` and may own multiple Tower workspaces. An Autopilot instance also has machine/bot identity and may participate in multiple workspaces. WApps need a clear installation workspace because their schemas, storage usage, and billing attribution must attach somewhere.

Working recommendation:

- Autopilot supports multiple explicit WApp Tower bindings.
- One WApp Tower binding can be selected as the default for new WApp installs.
- A WApp install always selects one WApp Tower binding.
- No fallback workspace or binding is created or used implicitly.
- The Autopilot bot/service key should be a member or service actor in each bound workspace.
- A human owner/admin can install the same WApp into multiple workspaces; each install gets a distinct `(workspace_owner_npub, app_npub)` namespace.
- Billing/storage attribution follows the workspace that owns the WApp installation.
- If a WApp needs to read or act across multiple workspaces, it should do so through explicit workspace memberships/grants, not by sharing one DB namespace across workspaces.

Open workspace questions:

- Can one WApp UI intentionally aggregate multiple workspace-specific WApp instances, and if so what grants and UI affordances are required?
- How does Flight Deck show WApps installed in a workspace vs WApps installed on an Autopilot machine?
- How should dev/staging/live WApp Tower bindings be named and selected in shared teams?

## Autopilot Responsibilities

Autopilot orchestrates WApp setup. Tower remains the authority for app identity and DB execution.

Expected install/start flow:

1. Autopilot creates or loads the WApp assignment.
2. Autopilot generates an app Nostr key if the assignment does not already have one, or imports a user-provided `APP_NSEC`.
3. Autopilot stores the generated or imported app key encrypted in its own database against the app assignment.
4. Autopilot injects the private key into the WApp process as `APP_NSEC`.
5. Autopilot derives and injects `APP_NPUB`.
6. Autopilot injects `TOWER_URL` and `WORKSPACE_OWNER_NPUB`.
7. Autopilot registers the WApp `app_npub` with Tower for the chosen workspace using owner/admin/service authority.
8. If the same workspace already has the same `app_npub` registered, Autopilot treats this as attaching to the existing WApp instance/namespace.
9. Autopilot starts the WApp.
10. The WApp backend signs Tower provision and migration requests with `APP_NSEC`.
11. The WApp backend serves its frontend/domain API.

Recommended runtime env:

```txt
APP_ID=
APP_LABEL=
APP_NPUB=
APP_NSEC=
TOWER_URL=
WORKSPACE_OWNER_NPUB=
```

The WApp should not require a database URL in the normal Tower-backed path.

## Security Requirements

- Tower must verify every WApp DB request with NIP-98.
- Tower must require the signer to match the registered app identity for the namespace.
- Table names and column names must be validated as identifiers, not interpolated from raw strings.
- Migration SQL must be parsed or constrained before execution.
- WApp DB requests must never accept schema-qualified table names from clients.
- Tower should record audit events for provisioning, migrations, CRUD writes, destructive table operations, and namespace cleanup.
- Dropping a WApp namespace should require explicit admin confirmation.
- App key rotation is not a v1 feature. Recovery should use the backed up/imported `APP_NSEC`.

## Cleanup And Uninstall

Default uninstall behavior:

- disable the app registration;
- reject future app-signed DB requests;
- keep the schema and data intact.

Destructive cleanup:

- requires workspace owner/admin confirmation;
- drops or archives the WApp schema;
- should export or snapshot data first when possible.

## Agents

Agents are users/actors validated via NIP-98. For normal WApp work, agents call the WApp's own NIP-98 APIs. The WApp backend enforces domain permissions and then signs generic Tower DB operations with `APP_NSEC`.

The generic Tower DB API is the backend-to-DB connection. It is not the primary agent integration surface.

## Remaining Questions

1. Should Autopilot persist the generated app key encrypted, or regenerate only when assignment state is recreated?
   - Decision: persist generated and imported app keys encrypted in Autopilot's database against the app assignment. Do not silently regenerate existing keys.
2. Where should app key rotation state live: Autopilot only, Tower app registration, or both?
   - Decision: key rotation is not a v1 feature.
3. Should Tower support app-signed named query registration in addition to constrained CRUD/query?
   - Open. Constrained CRUD/query is v1. Named queries may be useful later for reporting or joins, but should not block the first implementation.
4. Should app schemas support functions/triggers in a later phase?
   - Open. Defer until a concrete WApp needs them.
5. How does a WApp installed in multiple workspaces present a unified UI, if at all?
   - Open. Each workspace/app npub pair is a separate instance; aggregation would be an app-level feature.
6. How should app namespace storage be measured for billing?
   - Open. Billing attaches to the owning workspace, but measurement details still need implementation design.
7. Should Flight Deck expose WApp DB/migration health, or only WApp runtime health from Autopilot?
   - Open.

## Recommendation

Implement one generic Tower WApp DB API that accepts app-signed provision, migration, CRUD, and constrained query requests. Autopilot should generate and inject `APP_NSEC`, register the app with Tower, and start the WApp. The WApp backend should own its migrations and domain API, and Tower should own all actual Postgres execution.

Kindling should be the reference WApp for this model.
