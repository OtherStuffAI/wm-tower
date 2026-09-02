# Tower Postgres App Backend Design

## Purpose

Tower should provide a plaintext, schema-enforced Postgres backend for Wingman apps and WApps over HTTPS.

## Personal Daily Scope

Daily Scope is keyed by `workspace_id + owner_actor_id + note_date`. `scope_id`
and `channel_id` are optional context metadata only; they do not determine
identity, visibility, or uniqueness.

Owners can read and write their own Daily Scope. Agents can read or write a
human owner's Daily Scope only through explicit rows in
`flightdeck_pg_daily_scope_agent_access`; normal workspace agent membership and
channel grants do not confer Daily Scope access. Yoke is not part of this path:
agents should use the typed Flight Deck PG/Tower routes directly.

The Daily Scope API supports:

- `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-notes`
  with `note_date`, `owner_actor_id`, `owner_npub`, and `limit` filters.
- `POST /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-notes`
  with optional `owner_actor_id`/`owner_npub`, `body`, `focus`, `metadata`, and
  up to five checklist `items`.
- `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-notes/:dailyNoteId`
  with owner-or-explicit-agent authorization.
- `GET/POST /api/v4/flightdeck-pg/workspaces/:workspaceId/daily-scope/agent-access`
  for the owner's personal My Agents toggle.

This is a special Tower backend mode outside encrypted record sync. It is for apps that currently use a local SQLite database and need:

- concurrent access;
- simple CRUD APIs;
- real tables and columns;
- type safety stronger than encrypted record payloads;
- easy backup, export, inspection, and migration;
- Tower-mediated row-level access by workspace, app, user, and group.

Example apps:

- Autopilot sessions, runs, triggers, pipelines, and managed app state;
- Wingman WApps;
- customer apps such as Census;
- lightweight operational apps that would otherwise use SQLite.

The core mental model is:

```text
Tower
  workspace
    app_npub
      tables
        rows
```

Tower owns authentication, schema activation, table creation, SQL generation, and row-level access. Apps do not receive raw Postgres credentials and do not submit arbitrary SQL.

## Backend Modes

Tower should keep these backend modes distinct:

| Mode | Payload visibility to Tower | Purpose | Contract |
| --- | --- | --- | --- |
| Encrypted record sync | Opaque ciphertext | shared workspace materialization for Flight Deck/Yoke | schema-light records, client translators own meaning |
| Storage | metadata visible, object content external | files/blobs | explicit object lifecycle and ACLs |
| Graph memory | selected fields visible | memory and graph traversal | graph/memory ACLs |
| Postgres app backend | schema and row data visible | app/WApp operational backend | typed tables, CRUD, constraints, queries |

The Postgres app backend is not end-to-end encrypted. Tower can inspect schemas and rows by design. That visibility is what allows Tower to validate, index, query, back up, and migrate app data.

Apps can still store encrypted values in specific columns, but Tower can only treat those columns as opaque strings or bytes. Any field that must be filtered, sorted, constrained, referenced, or validated should be plaintext to Tower.

## Design Decision

Use **Tower-managed typed Postgres tables per workspace/app/table** as the primary model.

Do not use one global JSONB table as the primary app backend. Do not make generic document storage the main abstraction.

Use the existing main Tower Postgres database for v1. Do not add a new Docker service or a separate app-backend database in the first implementation.

Reasons:

- app backend access depends on Tower workspace, app, user, and group tables already in the main database;
- same-database transactions can update metadata and generated app tables atomically;
- backups stay simple because one Tower database contains workspace authority plus app backend state;
- no extra connection pools, credentials, health checks, or compose dependencies are needed;
- local and self-hosted deployments stay easy.

Generated app tables live in a dedicated Postgres schema inside the main Tower DB:

```text
database: coworker_v4
schema:   public       -- Tower authority, records, groups, metadata
schema:   appdb        -- generated app backend tables
```

A separate app backend database can be added later if a deployment needs hard resource isolation, but it should not be the default.

The default physical shape is:

```text
appdb.<generated_table_name>
```

Example logical app:

```text
workspace_owner_npub = npub1customer...
app_npub             = npub1census...
tables:
  households
  people
  survey_responses
```

Example physical tables:

```text
appdb.w_ab12_a_cd34_t_households
appdb.w_ab12_a_cd34_t_people
appdb.w_ab12_a_cd34_t_survey_responses
```

Tower metadata maps logical names to physical names. Apps only use logical table names through Tower APIs.

## Resolved Decisions

- Physical table names should be hash-based/generated by Tower. Human-readable names live in Tower metadata and API/table-viewer surfaces.
- App backend schemas are workspace-local. In product terms, the workspace is the business/customer Tower, and that workspace owns its app backends.
- Table data should be inspectable through explicit Tower/WApp table viewer surfaces rather than raw Postgres credentials.
- App uninstall should disable APIs immediately and retain physical tables until a retention/export window expires.
- The first implementation should prioritize a simple SQLite replacement: typed tables, CRUD, constrained queries, concurrent writes, backup/export, and easy inspection.

## Why Typed Tables

Most target apps already think in SQLite tables. A Tower app backend should preserve that model:

```sql
households(id, name, postcode, status)
people(id, household_id, first_name, last_name)
survey_responses(id, person_id, submitted_at)
```

Typed tables are better than generic JSONB storage for this use case because they provide:

- real Postgres column types;
- natural indexes;
- native uniqueness checks;
- native enum/check constraints;
- simpler debugging with `psql`;
- easier app-level export and migration;
- clearer backup/restore story;
- better performance for normal CRUD/query workloads;
- a mental model close to SQLite.

JSONB remains useful, but as a column type:

```sql
metadata JSONB
settings JSONB
raw_payload JSONB
```

JSONB should not be the whole storage model for serious app state.

## Non-Goals

- Do not expose raw Postgres credentials to apps.
- Do not expose arbitrary SQL over HTTPS in v1.
- Do not let apps create arbitrary functions, triggers, extensions, or unsafe DDL.
- Do not replace encrypted record sync for Flight Deck/Yoke materialization.
- Do not silently treat `app_npub` as a user or workspace admin.
- Do not build a full Supabase clone in v1.

## Core Concepts

### Workspace

The Tower workspace boundary:

```text
workspace_owner_npub
```

This is the top-level tenant.

### App Namespace

The app identity:

```text
app_npub
```

This can be:

- a Wingman WApp;
- Autopilot;
- a customer app such as Census;
- another app installed into a workspace.

`app_npub` scopes tables. It does not itself grant access.

### Table

A logical app table:

```text
households
sessions
pipeline_runs
customers
tickets
```

Tower generates the physical Postgres table and stores the mapping.

### Row

Every row has Tower security and lifecycle columns plus app-defined columns.

Standard Tower columns:

```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
row_id TEXT NOT NULL,
owner_npub TEXT NOT NULL,
visibility TEXT NOT NULL DEFAULT 'workspace',
group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
row_version INTEGER NOT NULL DEFAULT 1,
created_by_npub TEXT NOT NULL,
updated_by_npub TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
deleted_at TIMESTAMPTZ
```

Then app columns follow:

```sql
name TEXT NOT NULL,
postcode TEXT,
status TEXT NOT NULL
```

## Metadata Tables

Tower core migrations create metadata tables. These are normal Tower schema migrations.

These tables should be added to the main Tower database through:

- `src/schema/001_init.sql`;
- `src/schema/ensure-runtime-schema.ts`;
- `src/schema/run-migrations.ts` if a later migration runner path is needed.

No separate database bootstrap is needed for v1.

Suggested metadata:

```sql
CREATE SCHEMA IF NOT EXISTS appdb;

CREATE TABLE workspace_app_db_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  schema JSONB NOT NULL,
  created_by_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  CHECK (status IN ('draft', 'active', 'superseded', 'rejected')),
  UNIQUE (workspace_owner_npub, app_npub, schema_version),
  UNIQUE (workspace_owner_npub, app_npub, schema_hash),
  FOREIGN KEY (workspace_owner_npub, app_npub)
    REFERENCES workspace_apps(workspace_owner_npub, app_npub)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_workspace_app_db_schemas_active
  ON workspace_app_db_schemas(workspace_owner_npub, app_npub)
  WHERE status = 'active';

CREATE TABLE workspace_app_db_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  logical_table_name TEXT NOT NULL,
  physical_schema TEXT NOT NULL DEFAULT 'appdb',
  physical_table_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (workspace_owner_npub, app_npub, logical_table_name),
  UNIQUE (physical_schema, physical_table_name)
);

CREATE TABLE workspace_app_db_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  from_schema_version INTEGER,
  to_schema_version INTEGER NOT NULL,
  migration_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  plan JSONB NOT NULL,
  applied_by_npub TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ,
  error TEXT,
  CHECK (status IN ('pending', 'applied', 'failed', 'rolled_back'))
);
```

The physical app tables live in `appdb`. The metadata stays with Tower's normal tables.

## Schema Shape

Apps define tables and columns in a restricted schema format. Tower validates this schema and generates SQL.

Example Census schema:

```json
{
  "schema_version": 1,
  "app_name": "Census",
  "tables": {
    "households": {
      "default_visibility": "workspace",
      "columns": {
        "name": {
          "type": "text",
          "required": true,
          "max_length": 300
        },
        "postcode": {
          "type": "text",
          "indexed": true,
          "max_length": 20
        },
        "status": {
          "type": "text",
          "required": true,
          "default": "draft",
          "enum": ["draft", "complete"]
        },
        "notes": {
          "type": "text"
        },
        "metadata": {
          "type": "jsonb"
        }
      },
      "unique": [
        {
          "name": "household_postcode_name",
          "columns": ["postcode", "name"]
        }
      ],
      "indexes": [
        {
          "name": "household_status",
          "columns": ["status"]
        },
        {
          "name": "household_postcode",
          "columns": ["postcode"]
        }
      ],
      "write_policy": {
        "create": "workspace_member",
        "update": "visible_member",
        "delete": "owner_or_workspace_admin"
      }
    },
    "people": {
      "default_visibility": "workspace",
      "columns": {
        "household_row_id": {
          "type": "text",
          "required": true,
          "indexed": true
        },
        "first_name": {
          "type": "text",
          "required": true
        },
        "last_name": {
          "type": "text",
          "required": true
        },
        "date_of_birth": {
          "type": "date"
        }
      },
      "references": [
        {
          "name": "person_household",
          "column": "household_row_id",
          "to_table": "households",
          "to_column": "row_id",
          "on_missing": "reject"
        }
      ]
    }
  }
}
```

Example Autopilot schema:

```json
{
  "schema_version": 1,
  "app_name": "Autopilot",
  "tables": {
    "sessions": {
      "default_visibility": "workspace",
      "columns": {
        "title": { "type": "text", "required": true, "max_length": 300 },
        "status": {
          "type": "text",
          "required": true,
          "enum": ["queued", "running", "paused", "done", "failed", "cancelled"],
          "indexed": true
        },
        "model": { "type": "text", "max_length": 80 },
        "agent_npub": { "type": "npub", "indexed": true },
        "workspace_path": { "type": "text", "max_length": 1000 },
        "started_at": { "type": "timestamptz" },
        "finished_at": { "type": "timestamptz" },
        "settings": { "type": "jsonb" }
      },
      "indexes": [
        { "name": "sessions_status_created", "columns": ["status", "created_at"] },
        { "name": "sessions_agent", "columns": ["agent_npub"] }
      ]
    },
    "pipeline_runs": {
      "default_visibility": "workspace",
      "columns": {
        "pipeline_id": { "type": "text", "required": true, "indexed": true },
        "session_row_id": { "type": "text", "indexed": true },
        "status": { "type": "text", "required": true, "indexed": true },
        "started_at": { "type": "timestamptz" },
        "finished_at": { "type": "timestamptz" },
        "result": { "type": "jsonb" }
      }
    }
  }
}
```

## Supported Types

Start with a small type system:

| Schema type | Postgres type | Notes |
| --- | --- | --- |
| `text` | `TEXT` | optional `max_length` creates a check constraint |
| `integer` | `INTEGER` | standard signed integer |
| `bigint` | `BIGINT` | large counts/ids |
| `numeric` | `NUMERIC` | money/credits/measurements |
| `boolean` | `BOOLEAN` | true/false |
| `date` | `DATE` | calendar date |
| `timestamptz` | `TIMESTAMPTZ` | timestamps |
| `uuid` | `UUID` | UUID values |
| `npub` | `TEXT` | validated by Tower as npub-like |
| `jsonb` | `JSONB` | flexible payload/metadata |

Do not support arbitrary SQL types in v1.

## Table Creation Flow

Table creation occurs through schema activation, not app SQL.

1. Workspace manager registers or enables an app namespace:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps
```

2. Workspace manager publishes a schema draft:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas
```

3. Tower validates:

- app exists in `workspace_apps`;
- actor can manage the workspace;
- table and column names are safe;
- requested types are supported;
- indexes and constraints are within quota;
- no raw SQL exists in the schema;
- migration from the active version is allowed.

4. Tower computes a canonical `schema_hash`.

5. Tower generates a DDL plan.

6. Tower activates the schema:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas/{schemaVersion}/activate
```

7. Tower executes the DDL plan and stores table metadata.

8. Tower marks the schema active.

Activation should be atomic where Postgres allows it. If index creation needs `CONCURRENTLY`, Tower should run that as a controlled async step and keep the schema in a `pending_index` or similar state until complete.

Implementation detail:

- schema publish stores only metadata and a DDL plan;
- schema activation executes the DDL plan using Tower's main DB connection;
- DDL identifiers are generated by Tower and quoted with a structured identifier helper;
- app-supplied names are validated and stored as logical metadata only;
- activation records every generated statement hash in `workspace_app_db_migrations`;
- failed activation leaves the previous active schema untouched.

## Generated DDL Example

Given logical table:

```json
{
  "tables": {
    "households": {
      "columns": {
        "name": { "type": "text", "required": true, "max_length": 300 },
        "postcode": { "type": "text", "indexed": true },
        "status": {
          "type": "text",
          "required": true,
          "default": "draft",
          "enum": ["draft", "complete"]
        }
      }
    }
  }
}
```

Tower may generate:

```sql
CREATE TABLE appdb.w_ab12_a_cd34_t_households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id TEXT NOT NULL,
  owner_npub TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'workspace',
  group_id UUID REFERENCES v4_groups(id) ON DELETE SET NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_by_npub TEXT NOT NULL,
  updated_by_npub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  name TEXT NOT NULL,
  postcode TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  UNIQUE (row_id),
  CHECK (visibility IN ('private', 'group', 'workspace')),
  CHECK (char_length(name) <= 300),
  CHECK (status IN ('draft', 'complete'))
);

CREATE INDEX idx_w_ab12_a_cd34_households_owner
  ON appdb.w_ab12_a_cd34_t_households(owner_npub);

CREATE INDEX idx_w_ab12_a_cd34_households_group
  ON appdb.w_ab12_a_cd34_t_households(group_id);

CREATE INDEX idx_w_ab12_a_cd34_households_postcode
  ON appdb.w_ab12_a_cd34_t_households(postcode);
```

Apps never call this SQL directly. Tower generates and executes it.

## API Surface

All app backend routes require NIP-98 auth. Tower resolves workspace session keys to real `user_npub` like the rest of Tower.

### Schema APIs

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas
GET  /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas
GET  /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schema
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas/{schemaVersion}/activate
```

Publishing and activation require workspace manager permission.

### Table APIs

```text
GET /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables
GET /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/schema
```

These return logical table names and column schema, not physical table names by default. Admin routes can expose physical mapping for inspection/export.

### Row CRUD APIs

```text
POST   /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows
GET    /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows
GET    /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
PATCH  /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
PUT    /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
DELETE /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
```

Tower should support:

- `If-Match` for optimistic concurrency;
- `Idempotency-Key` for safe retries;
- soft delete by default.

### Query API

Do not expose arbitrary SQL. Use a constrained query DSL over declared columns:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/query
```

Request:

```json
{
  "where": [
    { "column": "status", "op": "eq", "value": "running" },
    { "column": "created_at", "op": "gte", "value": "2026-05-01T00:00:00.000Z" }
  ],
  "order_by": [
    { "column": "created_at", "direction": "desc" }
  ],
  "limit": 100,
  "offset": 0
}
```

Allowed operators:

- `eq`, `neq`
- `lt`, `lte`, `gt`, `gte`
- `in`
- `is_null`, `not_null`
- `prefix` for bounded text fields

Rules:

- columns must exist in the active schema;
- Tower injects row visibility filters;
- max `limit` defaults to 100 and caps at 500;
- unindexed expensive queries can be rejected later if needed;
- result shape is logical column names, not physical table internals.

Minimum Autopilot query DSL:

- equality filters on indexed columns;
- `in` filters on indexed text/status columns;
- timestamp range filters using `gte`/`lte`;
- `is_null`/`not_null`;
- ordering by one indexed column plus `created_at`/`updated_at`;
- `limit` and cursor/offset pagination;
- soft-delete exclusion by default;
- optional `include_deleted` for workspace admins or service maintenance.

That should cover common SQLite replacement queries:

- list recent sessions by status;
- fetch one session by `row_id`;
- list pipeline runs for a session;
- list active/running jobs;
- list triggers by enabled state;
- list managed apps by status;
- page session events by `created_at`.

### Bulk Transaction API

SQLite-backed apps often do multi-row operations. Add this early:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tx
```

Request:

```json
{
  "idempotency_key": "6f9e7a4d-...",
  "operations": [
    {
      "op": "insert",
      "table": "sessions",
      "row_id": "session_123",
      "values": {
        "title": "Investigate CI",
        "status": "queued"
      }
    },
    {
      "op": "insert",
      "table": "pipeline_runs",
      "row_id": "run_456",
      "values": {
        "pipeline_id": "daily-check",
        "session_row_id": "session_123",
        "status": "queued"
      }
    }
  ]
}
```

Tower validates all operations, then writes in one Postgres transaction.

## Row-Level Security Model

Tower enforces access before executing queries. Later, Postgres RLS should be added as defense in depth.

Row visibility:

- `private`: visible to `owner_npub`;
- `group`: visible to current members of `group_id`;
- `workspace`: visible to current members of the workspace.

`workspace` visibility needs one more design decision because app backends may have app-native user/group concepts that are separate from Flight Deck workspace groups.

### Workspace Visibility Options

Option A: reuse Tower workspace groups.

```text
workspace-visible row = visible to any current member of at least one Tower group in the workspace
group-visible row     = visible to current members of the referenced Tower group_id
```

Benefits:

- aligns with current Tower access model;
- avoids building a second membership system for v1;
- app rows can reuse existing workspace onboarding/offboarding;
- Postgres RLS can reuse Tower group membership tables;
- works well for operational apps like Autopilot where workspace membership is enough.

Downsides:

- Flight Deck/Tower groups may not match app-domain groups;
- apps such as Census may need roles/teams that are not Flight Deck groups;
- app-specific permissions could become awkward if forced through Tower groups.

Option B: app-native membership and roles.

```text
workspace-visible row = visible to app users according to app-managed membership tables
group-visible row     = visible to app-defined group/role membership, not necessarily Tower group_id
```

Benefits:

- lets each WApp define its own users, roles, groups, teams, departments, or tenancy rules;
- closer to normal app backend design;
- does not overload Flight Deck groups with app-specific concepts.

Downsides:

- Tower must still have a base rule for who can call the app backend at all;
- RLS becomes more complex because app-defined membership tables vary by schema;
- offboarding must bridge Tower membership and app-native membership;
- harder to make generic admin/export tooling explain access.

Recommended v1 compromise:

- Tower membership gates access to the installed app backend.
- `private` always means `owner_npub = resolved user_npub`.
- `workspace` means any Tower workspace member can see the row.
- `group` uses Tower `group_id` only when the app wants to reuse Tower groups.
- Apps that need app-native roles/groups should model them as normal app tables and enforce app-domain permissions in app logic first.
- A later version can add declarative app-native policies once we see repeated patterns.

Write policy is declared per table:

```json
{
  "write_policy": {
    "create": "workspace_member",
    "update": "visible_member",
    "delete": "owner_or_workspace_admin"
  }
}
```

Initial policy vocabulary:

- `owner`
- `visible_member`
- `group_member`
- `workspace_member`
- `workspace_admin`
- `owner_or_workspace_admin`

Avoid arbitrary policy expressions in v1.

## App Identity And Service Writes

`app_npub` scopes tables, but does not itself grant access.

Authenticated actor resolution:

- direct user signer -> `user_npub`;
- workspace session key signer -> resolved real `user_npub`;
- agent/bot signer -> that agent npub unless explicit delegation exists.

Default app behavior:

- browser/user writes are owned by the resolved `user_npub`;
- workspace operational rows can default to `workspace` visibility;
- user preferences can default to `private`;
- team/customer scoped rows can use `group`;
- background app service writes require explicit delegation.

Do not silently let an app daemon write as a user.

Recommended v1 service identity model:

- each installed app may have one or more registered app service npubs;
- service npubs are stored under `(workspace_owner_npub, app_npub, service_npub)`;
- workspace managers approve service npubs;
- service npubs can write only according to declared table service policies;
- service writes must set `created_by_npub`/`updated_by_npub` to the service npub;
- if a service writes on behalf of a user, the request must include an explicit `on_behalf_of_npub` and the table policy must allow it.

Suggested metadata:

```sql
CREATE TABLE workspace_app_service_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_owner_npub TEXT NOT NULL,
  app_npub TEXT NOT NULL,
  service_npub TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  approved_by_npub TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_owner_npub, app_npub, service_npub)
);
```

Suggested table policy:

```json
{
  "service_policy": {
    "create": "allowed_service",
    "update": "allowed_service",
    "delete": "workspace_admin",
    "on_behalf_of": false
  }
}
```

This is enough for Autopilot daemons and WApp background jobs without granting blanket workspace-admin behavior to `app_npub`.

## Migrations

There are two migration types.

### Tower Core Migrations

These are normal Tower migrations for metadata:

- `workspace_app_db_schemas`;
- `workspace_app_db_tables`;
- `workspace_app_db_migrations`;
- app backend helper tables;
- `appdb` schema creation.

They live in Tower source and run like other schema changes.

### App Schema Migrations

Apps publish schema versions. Tower generates safe DDL plans.

Automatically allowed:

- create table;
- add nullable column;
- add column with default;
- add non-unique index;
- add enum value;
- widen text length.

Require explicit migration plan:

- add required column without default;
- rename column;
- change type;
- add unique constraint over existing data;
- tighten enum;
- reduce max length.

Blocked in v1:

- arbitrary SQL;
- triggers;
- functions;
- extensions;
- cross-app foreign keys;
- destructive drop without export/retention.

Example migration request:

```json
{
  "from_schema_version": 1,
  "to_schema_version": 2,
  "operations": [
    {
      "op": "add_column",
      "table": "households",
      "column": "phone",
      "type": "text",
      "nullable": true
    },
    {
      "op": "rename_column",
      "table": "people",
      "from": "surname",
      "to": "last_name"
    }
  ]
}
```

Tower validates the plan, stores it, and applies generated SQL.

## Backups, Export, And Migration Out

Generated app tables are authoritative data. They must be included in Tower backups.

Because v1 uses the existing main Tower Postgres database, the default backup mechanism does not need a new container or a new backup target. Existing Postgres volume snapshots or `pg_dump` flows should include `appdb.*` automatically.

A normal Postgres backup captures:

- Tower workspace/group/auth tables;
- app backend metadata tables;
- generated `appdb.*` tables;
- generated indexes and constraints.

Restore requires metadata and physical tables to stay consistent. Do not restore app tables without their metadata mapping.

This design makes app-level export straightforward:

```text
Export workspace app backend
Export table
Import app backend
Drop app backend after retention
```

For Census:

```text
workspace_owner_npub + census app_npub + households table
```

maps to a physical table in `appdb`. To migrate it elsewhere, Tower can export:

- schema JSON;
- table DDL;
- table data;
- app metadata.

Direct Postgres operators can also inspect/copy the physical table when necessary.

This is the main reason typed tables fit the product better than a shared JSONB object table.

### Deployment Shape

No new Docker service is required for v1.

Current default stack remains:

```text
wingman-tower-postgres   -- main Tower DB; also contains appdb schema
wingman-tower-minio      -- storage objects
wingman-tower-b3         -- Tower API
```

Graph memory may still use its existing optional `wingman-tower-graph-postgres` service because it depends on Apache AGE and has a distinct lifecycle. The app backend does not need that separation.

No new required environment variables are needed for v1. Optional knobs can be added:

```text
APP_BACKEND_ENABLED=true
APP_BACKEND_RETENTION_DAYS=30
APP_BACKEND_MAX_TABLES_PER_APP=25
APP_BACKEND_MAX_COLUMNS_PER_TABLE=100
APP_BACKEND_MAX_INDEXES_PER_TABLE=8
APP_BACKEND_MAX_PENDING_SCHEMAS_PER_APP=5
APP_BACKEND_MAX_ROWS_PER_TX=500
```

Default local/self-hosted behavior should be enabled only after the feature is implemented and covered by tests. During development, `APP_BACKEND_ENABLED=false` can gate routes if needed.

### Future Isolation Options

If a deployment outgrows same-database app tables, Tower can add an isolation tier later:

1. same database, separate schema: default v1;
2. same Postgres server, separate database per Tower or per large workspace;
3. separate Postgres service for app backend workloads;
4. dedicated database for a high-volume app/customer.

Do not start with those tiers. They add credentials, backup targets, cross-database consistency problems, and operational overhead before there is evidence they are needed.

## App Disable, Uninstall, And Retention

Uninstall should not immediately drop physical tables.

Recommended behavior:

1. Mark the app backend disabled.
2. Reject normal app API reads/writes with `app_backend_disabled`.
3. Keep admin/export APIs available to workspace managers.
4. Retain physical tables until the configured retention window expires.
5. After retention, allow explicit purge or scheduled purge.

Suggested metadata fields:

```sql
disabled_at TIMESTAMPTZ,
delete_eligible_at TIMESTAMPTZ,
purged_at TIMESTAMPTZ
```

This gives a clean recovery/export window and avoids destructive surprises when a WApp is removed.

## WApp Install Contract

WApps should declare backend needs in their manifest.

Example:

```json
{
  "app_npub": "npub1...",
  "name": "Customer Desk",
  "backend": {
    "type": "tower-postgres-app",
    "schema_version": 1,
    "schema": {
      "tables": {
        "customers": {
          "columns": {
            "name": { "type": "text", "required": true },
            "status": { "type": "text", "indexed": true }
          }
        },
        "tickets": {
          "columns": {
            "customer_row_id": { "type": "text", "indexed": true },
            "title": { "type": "text", "required": true },
            "status": { "type": "text", "required": true, "indexed": true }
          }
        }
      }
    }
  }
}
```

Install flow:

1. Workspace manager installs/enables the WApp.
2. Tower registers the `workspace_apps` row.
3. Tower validates the WApp backend schema.
4. Tower generates and applies table DDL.
5. Tower activates the schema.
6. Tower returns backend connection details.

Runtime connection details:

```json
{
  "workspace_owner_npub": "npub1...",
  "app_npub": "npub1...",
  "direct_https_url": "https://tower.example.com",
  "backend": {
    "type": "tower-postgres-app",
    "schema_version": 1,
    "schema_hash": "sha256:...",
    "base_url": "https://tower.example.com/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}"
  }
}
```

The WApp uses NIP-98 signed HTTPS requests. It does not receive database credentials.

## What JSONB Is For

JSONB should remain available as a column type:

- `metadata`;
- flexible settings;
- raw imported payloads;
- optional app-specific extension data;
- fields that do not need strong query/constraint support.

Example:

```json
{
  "columns": {
    "title": { "type": "text", "required": true },
    "status": { "type": "text", "indexed": true },
    "metadata": { "type": "jsonb" }
  }
}
```

Do not make JSONB the default storage for every row. That would move the product back toward a document/object store rather than a simple SQLite-to-Postgres backend.

## Guardrails

To avoid turning this into unsafe dynamic database hosting, enforce quotas:

- max apps per workspace;
- max tables per app;
- max columns per table;
- max indexes per table;
- max row size;
- max rows per bulk transaction;
- max query limit;
- max migration operations per activation.

Also enforce naming rules:

- logical names must be short ASCII identifiers;
- physical names are generated by Tower;
- user-supplied names are never interpolated directly into SQL;
- every generated SQL statement is derived from validated schema AST.

### Table Proliferation Control

This design intentionally creates real app tables, so Tower must control table growth.

Product rule:

> A WApp schema defines a small fixed set of durable tables. It must not create dynamic tables at runtime.

Do not create tables per user, session, run, tenant, import, or event stream. Use stable app tables plus row-level scoping:

```text
Good:
  sessions
  session_events
  pipeline_runs
  households
  people

Bad:
  session_abc123_events
  user_npub1xyz_settings
  import_2026_05_26_rows
```

Use row columns for dynamic scoping:

```text
owner_npub
visibility
group_id
session_row_id
import_id
tenant_id
created_at
```

Recommended default quotas:

```text
APP_BACKEND_MAX_TABLES_PER_APP=25
APP_BACKEND_MAX_COLUMNS_PER_TABLE=100
APP_BACKEND_MAX_INDEXES_PER_TABLE=8
APP_BACKEND_MAX_PENDING_SCHEMAS_PER_APP=5
APP_BACKEND_MAX_ROWS_PER_TX=500
```

Generated tables should be isolated and discoverable:

- all generated tables live in `appdb`;
- physical names are hash-based;
- logical names live in `workspace_app_db_tables`;
- workspace managers inspect tables through Tower table viewer/export APIs;
- direct Postgres operators can map physical names back to metadata.

Every generated table should receive a Postgres comment for operator clarity:

```sql
COMMENT ON TABLE appdb.w_ab12_a_cd34_t_ef56 IS
'workspace=npub1..., app=npub1..., table=households';
```

Tower should include an app backend audit that detects:

- metadata exists but physical table is missing;
- physical table exists without metadata;
- disabled app backend is past retention;
- app/table/index count exceeds quota;
- generated table size exceeds configured thresholds;
- migration status is stuck or failed.

This keeps typed tables operationally clean while preserving the SQLite-like mental model.

## Error Contract

Validation failures should be structured:

```json
{
  "error": "table validation failed",
  "code": "schema_validation_failed",
  "details": [
    {
      "table": "households",
      "column": "status",
      "message": "must be one of draft, complete"
    }
  ]
}
```

Common codes:

- `app_not_found`
- `schema_missing`
- `schema_invalid`
- `schema_activation_failed`
- `table_not_found`
- `column_not_found`
- `row_validation_failed`
- `visibility_forbidden`
- `workspace_forbidden`
- `group_forbidden`
- `row_conflict`
- `unique_constraint_violation`
- `reference_constraint_violation`
- `stale_row_version`
- `migration_failed`

## Autopilot First Cut

Autopilot should start with:

- `sessions`;
- `session_events`;
- `pipelines`;
- `pipeline_runs`;
- `pipeline_steps`;
- `triggers`;
- `managed_apps`;
- `wapps`.

Migration path:

1. Define Autopilot schema from current SQLite tables.
2. Create Tower app namespace for Autopilot.
3. Activate schema in a test workspace.
4. Dual-write SQLite and Tower for a short period.
5. Backfill SQLite rows through bulk transaction API.
6. Switch reads to Tower.
7. Keep SQLite as cache if useful, then remove or demote it.

## What Is Still Missing

Before this is production-ready:

- metadata tables and runtime schema checks;
- schema publish/list/activate APIs;
- safe DDL generator;
- identifier generation and physical table mapping;
- row CRUD/query APIs using generated SQL;
- row access enforcement;
- row version/ETag and idempotency;
- bulk transaction API;
- app schema migration runner;
- admin inspection/export endpoints;
- backup/restore documentation;
- SSE events for app table changes;
- quotas/billing for app backend storage and writes;
- explicit app service delegation model;
- optional Postgres RLS defense in depth.

## Implementation Plan

### Phase 0: Reconcile Current Prototype

The current experimental generic app-row surface should not become the final API. Before building the typed table backend:

- decide whether to remove the prototype `workspace_app_rows` API or keep it behind a development flag;
- avoid documenting it as the public app backend;
- ensure OpenAPI points to the typed table design once implemented.

### Phase 1: Core Metadata And Config

Add metadata and feature flag support:

- add `appdb` schema creation to `src/schema/001_init.sql`;
- add `workspace_app_db_schemas`;
- add `workspace_app_db_tables`;
- add `workspace_app_db_migrations`;
- add `workspace_app_service_identities` if service writes are included in v1;
- mirror runtime creation in `src/schema/ensure-runtime-schema.ts`;
- add app backend config to `src/config.ts`;
- add route-level disabled response when `APP_BACKEND_ENABLED=false`.

No Docker Compose change is needed in this phase.

### Phase 2: Schema Validator And DDL Planner

Add a service that turns app schemas into safe plans:

- validate table names and column names;
- validate supported types;
- validate defaults, enums, required fields, indexes, and unique constraints;
- generate stable physical table names;
- generate an ordered DDL plan;
- compute canonical schema hash;
- reject unsupported or unsafe schema features.

Suggested files:

```text
src/services/app-backend-schema.ts
src/services/app-backend-ddl.ts
src/routes/app-backend.ts
tests/app-backend-schema.test.ts
```

### Phase 3: Schema APIs

Implement:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas
GET  /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas
GET  /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schema
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/schemas/{schemaVersion}/activate
```

Rules:

- publish/activate require workspace manager permission;
- app namespace must exist;
- schema publish stores draft metadata only;
- activation applies generated DDL and records metadata;
- activation failure leaves prior active schema intact.

Add OpenAPI and tests.

### Phase 4: Generated Table CRUD

Implement row APIs:

```text
POST   /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows
GET    /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows
GET    /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
PATCH  /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
PUT    /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
DELETE /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/tables/{tableName}/rows/{rowId}
```

Rules:

- resolve logical table to physical table through metadata;
- validate requested columns against active schema;
- inject access predicates into every read/update/delete;
- default delete to soft delete;
- return logical column names;
- support `row_version` and `If-Match`.

### Phase 5: Query DSL

Implement constrained query over declared columns:

- equality;
- `in`;
- timestamp ranges;
- null checks;
- bounded prefix;
- ordering;
- pagination.

Do not support joins or arbitrary SQL in v1.

### Phase 6: Bulk Transaction API

Implement:

```text
POST /api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tx
```

Rules:

- max operation count;
- validate all operations before writing;
- execute in one Postgres transaction;
- support idempotency key;
- return per-operation results.

### Phase 7: Admin/Table Viewer And Export

Add inspection/export surfaces:

- list app backend tables for a workspace/app;
- show logical schema and physical mapping to workspace managers;
- table viewer reads through Tower APIs and logical names;
- export app backend schema and data;
- export one table;
- mark app backend disabled;
- purge after retention.

This is where the user-facing "I know Census is in the Census table" workflow becomes practical.

### Phase 8: SSE, Billing, And Quotas

Add:

- `app-table-row-changed` SSE events;
- usage measurement for generated tables;
- quotas for tables, columns, indexes, row size, and tx operations;
- billing integration if hosted/metered mode requires it.

### Phase 9: Optional Postgres RLS

After service-level access is stable, add RLS defense in depth:

- make Tower use a non-owner DB role for app table queries if practical;
- set transaction-local identity variables;
- generate RLS policies on app tables;
- keep service-level checks as the primary authorization logic.

### Phase 10: Autopilot Migration

Migrate Autopilot from SQLite:

1. inventory current SQLite tables and queries;
2. define Autopilot app backend schema;
3. activate schema in a dev workspace;
4. add a Tower-backed repository/adapter in Autopilot;
5. dual-write SQLite and Tower;
6. backfill SQLite data into Tower through bulk tx;
7. switch reads to Tower;
8. retain SQLite as cache if useful;
9. remove or demote SQLite once stable.

## Remaining Questions

- Should the v1 `workspace` visibility rule mean membership in any Tower workspace group, or should it be limited to the workspace default group?
- Do we need app-native role/group policy declarations in v1, or is app logic plus Tower base membership enough for the first WApp backend pass?
- What retention window should disabled app backends use by default?
- Should app table viewer access be workspace-manager only, or can apps grant table-viewer access to non-manager operators?
- Should service identity registration live under app backend APIs, existing workspace app APIs, or a broader Tower delegation API?
