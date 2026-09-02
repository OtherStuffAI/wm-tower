# Postgres/AGE Graph Memory Design

## Purpose

Tower currently owns encrypted record sync, workspace/group authority, storage metadata, service identity, and NIP-98 authenticated API access. We also have graph-memory use cases that are awkward to secure with a standalone Neo4j service because tenancy and principal isolation need to align with Tower's Nostr identities, workspace keys, group keys, and app namespaces.

This document proposes an optional Postgres/Apache AGE graph backend inside Tower's deployment boundary. The goal is to support agent and team memory graphs while preserving Tower's existing access model:

- personal memories must not leak to other users or their agents;
- agent memories must be scoped to the agent npub that writes them;
- shared memories must be scoped to explicit workspace groups;
- app namespaces are client/application context, not memory owners;
- access rules must be enforced by Tower and by Postgres Row Level Security.

This document is intended to be build-ready for the first implementation pass, with a few explicit product/security questions called out at the end.

## Repository graph deltas and checkpoints

Code indexers and other corpus importers should use `POST /api/v4/graph/repository-deltas` when they need deletion, reconciliation, or durable Git checkpoints. The older `/import-runs` endpoint remains a merge-only generic import path.

Repository delta identity is the existing graph ACL scope plus `source`, `corpus_id`, and `repository_id`. Within that identity, all node IDs, edge IDs, and edge endpoint IDs must begin with:

```text
<corpus_id>:<repository_id>:
```

`corpus_id` and `repository_id` allow letters, numbers, `.`, `_`, `/`, and `-`; `:` is reserved as the prefix delimiter. This makes repository ownership directly verifiable without interpreting application-specific properties.

The operation has two modes:

- `incremental`: `base_sha` is required and must equal the locked current checkpoint. Explicit delete lists are applied before upserts.
- `full_rebuild`: may establish or replace a checkpoint. Existing edges and nodes under this repository prefix that are absent from the desired payload are removed, while other repositories and corpora are preserved.

Deletes, property replacement/merge, node and edge upserts, schema snapshot, import-run audit row, and checkpoint advancement occur in one RLS-protected transaction. Set `property_mode: "replace"` on a node or edge to replace its complete properties object; the default remains `merge` for compatibility. Repeating the current `head_sha` is a successful idempotent replay with zero mutation counts.

Before indexing, clients should call `GET /api/v4/graph/repository-checkpoints` with the same graph scope and required `source`. Optional `corpus_id` and `repository_id` filters select an exact checkpoint for skip-unchanged and `base_sha` decisions; either can also be used independently for discovery. The route accepts the standard `workspace_owner_npub`, `visibility`, `owner_npub`, `actor_npub`/`agent_npub`, `source_app_npub`, and `group_id` filters plus a bounded `limit`. It uses the normal graph allowlist, NIP-98 request resolution, workspace/app/group checks, and graph RLS identity. Malformed filters return `400`, unauthorized requested actor/workspace/app scopes return `403`, and valid filters that have no visible checkpoint return an empty `checkpoints` array. Responses contain only repository identity, head/schema state, parser/index metadata, and `updated_at`; internal owner and writer columns are intentionally omitted.

Cross-repository edges are not accepted by this contract: both endpoints must have the declared prefix. If legacy graph data contains such an edge, deletion of its endpoint is rejected with `graph_delta_cross_repository_edge`; Tower never silently deletes another repository's relationship or node.

For repo-local markdown projections of graph-backed docs, see `docs/tower_managed_docs.md`.

## Resolved Product Decisions

- Agents write memories as the agent npub/nsec they control.
- Every agent npub has a personal graph space.
- App namespaces do not own memories; they are optional source attribution only.
- Group memory is readable by principals that currently have access to the group key through Tower membership/key resolution.
- Group memory uses stable `group_id` for ACL and `group_epoch`/`group_npub` for encryption metadata.
- Workspace admins can inspect graph usage/counts, but they do not automatically read agent personal memory.
- Graph memory is not a public billable resource in the first build; it is a self-hosted/private Tower feature.
- Graph use is gated by `GRAPH_ALLOWED_NPUBS`.
- Personal agent memories are owned by the agent npub and may omit workspace context.
- Group memories include workspace context because Tower groups belong to a workspace.

## High-Level Shape

Use a separate AGE-enabled Postgres database for graph memory, with Tower as the only supported API entry point.

```text
Client / agent / app
  signs NIP-98 request
        |
        v
Tower API
  validates signer
  resolves real user, workspace key, app namespace, group membership
  opens graph transaction
  SET LOCAL app.* identity settings
  calls allowlisted graph functions / queries
        |
        v
Graph Postgres + Apache AGE
  RLS-protected relational memory tables
  AGE graph labels/edges for traversal
```

Do not expose raw database credentials or unrestricted Cypher to agents. Tower remains the authority boundary.

## Docker / Database Layout

Preferred first deployment:

```text
wingman-tower-postgres        existing Tower database
wingman-tower-graph-postgres  AGE-enabled graph database
wingman-tower-b3              Tower API
```

Reasons to keep graph storage separate:

- AGE requires a custom Postgres image/extension lifecycle.
- Graph migrations and experimental query workload should not risk the main Tower DB.
- Credentials, backup cadence, retention, and resource limits can differ.
- The graph backend stays optional for portable Tower installs.
- It gives us a clean path to disable graph features without touching record sync/storage.

The graph service should use a separate database name, user, and password. Tower should connect with a non-owner role that does not bypass RLS.

Possible environment variables:

```text
GRAPH_ENABLED=true
GRAPH_AGE_GRAPH_NAME=tower_memory
GRAPH_DB_HOST=graph-postgres
GRAPH_DB_PORT=5432
GRAPH_DB_NAME=tower_graph
GRAPH_DB_ADMIN_USER=postgres
GRAPH_DB_ADMIN_PASSWORD=<required-admin-password>
GRAPH_DB_APP_USER=tower_graph_app
GRAPH_DB_APP_PASSWORD=<required-app-password>
GRAPH_DB_MAX_CONNECTIONS=10
GRAPH_ALLOWED_NPUBS=npub1agent...,npub1operator...
```

The first implementation should not use one opaque `GRAPH_DATABASE_URL`, because the bootstrap flow needs both an admin connection and an app connection:

- admin connection: creates database, extension, schema, owner/app roles, policies;
- app connection: used by Tower request handlers and constrained by RLS.

### Compose Service

Add this service to `docker-compose.prod.yml`:

```yaml
  graph-postgres:
    image: apache/age:release_PG16_1.6.0
    container_name: wingman-tower-graph-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${GRAPH_DB_NAME:-tower_graph}
      POSTGRES_USER: ${GRAPH_DB_ADMIN_USER:?set GRAPH_DB_ADMIN_USER}
      POSTGRES_PASSWORD: ${GRAPH_DB_ADMIN_PASSWORD:?set GRAPH_DB_ADMIN_PASSWORD}
    volumes:
      - tower-graph-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${GRAPH_DB_ADMIN_USER:?set GRAPH_DB_ADMIN_USER} -d ${GRAPH_DB_NAME:-tower_graph}"]
      interval: 5s
      timeout: 5s
      retries: 20
```

Then add it as an optional Tower dependency:

```yaml
  tower:
    depends_on:
      graph-postgres:
        condition: service_healthy
```

For the first build, `GRAPH_ENABLED=true` should make this dependency mandatory in prod compose. If `GRAPH_ENABLED=false`, Tower should start without a graph DB and all graph routes should return `404` or `501` with `graph_disabled`.

Add volume:

```yaml
volumes:
  tower-graph-postgres-data:
```

Tower environment additions:

```yaml
      GRAPH_ENABLED: ${GRAPH_ENABLED:-false}
      GRAPH_DB_HOST: ${GRAPH_DB_HOST:-graph-postgres}
      GRAPH_DB_PORT: ${GRAPH_DB_PORT:-5432}
      GRAPH_DB_NAME: ${GRAPH_DB_NAME:-tower_graph}
      GRAPH_DB_ADMIN_USER: ${GRAPH_DB_ADMIN_USER:?set GRAPH_DB_ADMIN_USER}
      GRAPH_DB_ADMIN_PASSWORD: ${GRAPH_DB_ADMIN_PASSWORD:?set GRAPH_DB_ADMIN_PASSWORD}
      GRAPH_DB_APP_USER: ${GRAPH_DB_APP_USER:?set GRAPH_DB_APP_USER}
      GRAPH_DB_APP_PASSWORD: ${GRAPH_DB_APP_PASSWORD:?set GRAPH_DB_APP_PASSWORD}
      GRAPH_DB_MAX_CONNECTIONS: ${GRAPH_DB_MAX_CONNECTIONS:-10}
      GRAPH_AGE_GRAPH_NAME: ${GRAPH_AGE_GRAPH_NAME:-tower_memory}
      GRAPH_ALLOWED_NPUBS: ${GRAPH_ALLOWED_NPUBS:-}
```

### Image Pinning

Use `apache/age:release_PG16_1.6.0` for the first build, then pin the immutable digest in the implementation PR. Docker Hub currently exposes this Postgres 16 AGE release tag. If the image is not stable enough for deployment, add a local `docker/graph-postgres/Dockerfile`.

Expected local image option:

```dockerfile
FROM postgres:16

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    postgresql-server-dev-16 \
  && git clone --depth 1 --branch PG16 https://github.com/apache/age.git /tmp/age \
  && make -C /tmp/age install \
  && rm -rf /tmp/age /var/lib/apt/lists/*
```

Decision rule: prefer the official `apache/age:release_PG16_1.6.0` image pinned by digest; otherwise build locally from a pinned AGE commit.

## Core Security Principle

RLS should protect graph memory rows even if a Tower query is wrong. Tower should also perform explicit authorization before reaching the graph DB.

For each graph transaction Tower sets session-local identity values:

```sql
SET LOCAL app.workspace_owner_npub = 'npub...';
SET LOCAL app.signer_npub = 'npub...';
SET LOCAL app.user_npub = 'npub...';
SET LOCAL app.actor_npub = 'npub...';
SET LOCAL app.source_app_npub = 'npub...';
SET LOCAL app.group_ids = '["uuid-1","uuid-2"]';
```

Definitions:

- `signer_npub`: NIP-98 signer for this request.
- `user_npub`: resolved real user. For workspace session keys, this is the owning user.
- `actor_npub`: effective acting identity. For agent memory writes this is the agent npub that controls the signing secret.
- `source_app_npub`: verified app namespace, when useful for client attribution. It is not the memory owner.
- `group_ids`: stable Tower group UUIDs the effective principal can read/write for this request.

The graph DB role used by Tower must not own graph tables and must not have `BYPASSRLS`.

## Tower Files To Add / Change

Concrete first-pass file layout:

```text
src/graph/config.ts
src/graph/db.ts
src/graph/migrations/001_graph_init.sql
src/graph/run-migrations.ts
src/graph/session.ts
src/graph/service.ts
src/routes/graph.ts
tests/graph.test.ts
```

Changes to existing files:

```text
docker-compose.prod.yml
docker/entrypoint.sh
src/config.ts
src/server.ts
src/openapi.ts
src/types.ts
```

`docker/entrypoint.sh` should run graph migrations only when enabled:

```sh
if [ "${GRAPH_ENABLED:-false}" = "true" ]; then
  echo "Running graph database migrations..."
  bun run graph:init
fi
```

Add package scripts:

```json
{
  "scripts": {
    "graph:init": "bun run src/graph/run-migrations.ts"
  }
}
```

`src/config.ts` should add:

```ts
graph: {
  enabled: /^(1|true|yes)$/i.test(process.env.GRAPH_ENABLED || ''),
  ageGraphName: process.env.GRAPH_AGE_GRAPH_NAME || 'tower_memory',
  db: {
    host: process.env.GRAPH_DB_HOST || '127.0.0.1',
    port: parseInt(process.env.GRAPH_DB_PORT || '5432', 10),
    database: process.env.GRAPH_DB_NAME || 'tower_graph',
    adminUser: requiredEnv('GRAPH_DB_ADMIN_USER'),
    adminPassword: requiredEnv('GRAPH_DB_ADMIN_PASSWORD'),
    appUser: requiredEnv('GRAPH_DB_APP_USER'),
    appPassword: requiredEnv('GRAPH_DB_APP_PASSWORD'),
    max: parseInt(process.env.GRAPH_DB_MAX_CONNECTIONS || '10', 10),
  },
  allowedNpubs: csvValues(process.env.GRAPH_ALLOWED_NPUBS),
}
```

`src/graph/db.ts` should export two connections:

- `getGraphAdminDb()`: admin/bootstrap only;
- `getGraphDb()`: request-time app role only.

Request handlers must never use the admin connection.

## Identity And Delegation

Tower already has several identity layers:

- real user Nostr keys;
- workspace user/session keys;
- app namespace keys, such as Flight Deck;
- group UUIDs and rotating group npubs;
- agent/bot identities.

Graph memory should not authorize directly on `signer_npub` unless the signer is also the effective principal. Instead:

- workspace keys resolve to their real `user_npub`;
- app keys or app context resolve to `source_app_npub` for attribution only; they do not own graph memory;
- agent keys resolve to `actor_npub`; every agent npub has its own personal graph space;
- group access uses stable `group_id`, not rotating `group_npub`.

This mirrors the existing Tower guidance: stable group UUIDs are durable ACL references; `group_npub` is crypto metadata.

## Ownership Model

Graph memory is npub-centric:

- each agent has a personal graph space under its own `actor_npub`;
- human users also have a personal graph space under `user_npub` when they write directly;
- group memory is scoped to stable Tower `group_id`;
- app namespaces do not own memories;
- app namespaces may be recorded as `source_app_npub` metadata for audit/debugging.

The first implementation should rename conceptual app ownership fields accordingly:

```text
source_app_npub request/source app metadata, optional
actor_npub      memory writer/owner for agent-personal memory
owner_npub      direct human owner for human-personal memory
group_id        stable group owner for group memory
```

Do not create an `app` visibility class in the first build. App-scoped graph memory can be revisited later, but current product intent is "npubs have graphs".

## Allowlist And Workspace Mapping

Graph memory is not a public billable resource in the first build. It is a self-hosted/private Tower feature available only to explicitly allowed npubs.

`GRAPH_ALLOWED_NPUBS` rules:

- if empty, graph routes are disabled unless `NODE_ENV=test`;
- a request is allowed when `signer_npub`, resolved `user_npub`, or resolved `actor_npub` is in the allowlist;
- group memory still also requires group access;
- app namespace registration does not grant graph access.

Workspace mapping is contextual, not ownership:

- personal agent memories may omit `workspace_owner_npub`;
- group memories should include `workspace_owner_npub` because Tower groups belong to a workspace;
- workspace context can be used for export/admin counts;
- workspace admins can inspect counts/metadata for group/workspace-scoped memories, not agent personal memory;
- no billing account is attached to graph memory in the first build.

This avoids implying that a workspace owner can read every personal graph. The hard ownership boundary remains the npub or group that owns the memory.

## Group Epoch Semantics

Group memory access needs two separate concepts:

1. Authorization to fetch graph rows.
2. Ability to decrypt graph payloads.

Tower should authorize graph row reads by stable `group_id` and current/relevant group membership, not merely by possession of any old `group_npub` secret. Possession of an old group nsec proves the holder once had access, but it should not be enough to keep fetching from Tower after removal.

Recommended rules:

- group memory rows store stable `group_id`;
- encrypted group payload metadata stores `group_epoch` and `group_npub`;
- writes must target the current group epoch;
- requests signed by a group key are accepted only when the signer is the current group epoch npub, unless an explicit historical-read mode is later added;
- removed members stop receiving rows from Tower after removal/rotation, even if they cached an old group nsec;
- existing members need historical epoch keys to decrypt older memories, matching Tower record payload behavior;
- re-added members should receive only current/future epoch keys unless an admin intentionally rewraps historical memory.

This means "anyone who can download the current group nsec can see group memory in principle", while still preserving revocation at Tower's serving boundary.

For first build, prefer user/agent NIP-98 auth plus Tower-resolved group membership. Direct group-key-signed graph requests can be a phase 2 addition, because they require careful current-epoch validation.

## Relational Tables As Authority

AGE is useful for traversal, but relational tables should remain the ACL source of truth.

Build-ready first-pass tables:

```sql
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

CREATE TABLE IF NOT EXISTS graph_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  agent_npub text,
  source_app_npub text,
  group_id uuid,
  visibility text not null,
  memory_type text not null,
  title text,
  summary text,
  body_ciphertext text,
  metadata jsonb not null default '{}'::jsonb,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group', 'workspace')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null and workspace_owner_npub is null)
    or (visibility = 'agent' and actor_npub is not null and group_id is null)
    or (visibility = 'group' and group_id is not null and workspace_owner_npub is not null)
    or (visibility = 'workspace' and workspace_owner_npub is not null)
  )
);

CREATE TABLE IF NOT EXISTS graph_memory_acl (
  memory_id uuid not null references graph_memories(id) on delete cascade,
  principal_npub text,
  actor_npub text,
  group_id uuid,
  access text not null,
  created_at timestamptz not null default now(),
  check (access in ('read', 'write', 'owner')),
  check (
    principal_npub is not null
    or actor_npub is not null
    or group_id is not null
  )
);

CREATE INDEX IF NOT EXISTS idx_graph_memories_workspace
  ON graph_memories(workspace_owner_npub, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_memories_owner
  ON graph_memories(workspace_owner_npub, owner_npub, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_memories_actor
  ON graph_memories(workspace_owner_npub, actor_npub, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_memories_group
  ON graph_memories(workspace_owner_npub, group_id, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_memories_app
  ON graph_memories(workspace_owner_npub, source_app_npub, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_memory_acl_memory
  ON graph_memory_acl(memory_id);
```

For shared/team memory, `graph_memory_acl.group_id` points at Tower's stable group UUID. Tower can periodically mirror current group membership into the graph DB, or each transaction can pass `app.group_ids` from the main Tower DB after auth resolution.

### Graph Entity Tables

Keep graph extraction tables relational too, then mirror them into AGE:

```sql
CREATE TABLE IF NOT EXISTS graph_entities (
  id uuid primary key default gen_random_uuid(),
  workspace_owner_npub text,
  entity_type text not null,
  entity_key text not null,
  display_name text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_entities_unique
  ON graph_entities(COALESCE(workspace_owner_npub, ''), entity_type, entity_key);

CREATE TABLE IF NOT EXISTS graph_memory_entities (
  memory_id uuid not null references graph_memories(id) on delete cascade,
  entity_id uuid not null references graph_entities(id) on delete cascade,
  relation text not null default 'mentions',
  weight numeric(10,4) not null default 1,
  primary key (memory_id, entity_id, relation)
);
```

## Example RLS Shape

RLS should be enabled on every authority table.

Conceptual read policy:

```sql
CREATE POLICY graph_memories_read ON graph_memories
FOR SELECT
USING (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    owner_npub = current_setting('app.user_npub', true)
    OR actor_npub = current_setting('app.actor_npub', true)
    OR group_id::text IN (
      SELECT jsonb_array_elements_text(
        COALESCE(NULLIF(current_setting('app.group_ids', true), ''), '[]')::jsonb
      )
    )
  )
);
```

Conceptual write policy:

```sql
CREATE POLICY graph_memories_write ON graph_memories
FOR INSERT
WITH CHECK (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND created_by_npub IN (
    current_setting('app.user_npub', true),
    current_setting('app.actor_npub', true)
  )
);
```

Build-ready helper functions:

```sql
CREATE OR REPLACE FUNCTION graph_current_group_ids()
RETURNS TABLE(group_id uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT value::uuid
  FROM jsonb_array_elements_text(
    COALESCE(NULLIF(current_setting('app.group_ids', true), ''), '[]')::jsonb
  ) AS value
  WHERE value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;

CREATE OR REPLACE FUNCTION graph_has_group(group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM graph_current_group_ids() g WHERE g.group_id = $1)
$$;
```

Build-ready RLS:

```sql
ALTER TABLE graph_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_memories FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_memory_acl ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_memory_acl FORCE ROW LEVEL SECURITY;

CREATE POLICY graph_memories_select ON graph_memories
FOR SELECT USING (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    owner_npub = NULLIF(current_setting('app.user_npub', true), '')
    OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
    OR (group_id IS NOT NULL AND graph_has_group(group_id))
    OR EXISTS (
      SELECT 1
      FROM graph_memory_acl acl
      WHERE acl.memory_id = graph_memories.id
        AND acl.access IN ('read', 'write', 'owner')
        AND (
          acl.principal_npub = NULLIF(current_setting('app.user_npub', true), '')
          OR acl.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
          OR (acl.group_id IS NOT NULL AND graph_has_group(acl.group_id))
        )
    )
  )
);

CREATE POLICY graph_memories_insert ON graph_memories
FOR INSERT WITH CHECK (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    (visibility = 'personal' AND owner_npub = NULLIF(current_setting('app.user_npub', true), ''))
    OR (visibility = 'agent' AND actor_npub = NULLIF(current_setting('app.actor_npub', true), ''))
    OR (visibility = 'group' AND group_id IS NOT NULL AND graph_has_group(group_id))
    OR (visibility = 'workspace' AND EXISTS (
      SELECT 1 FROM graph_current_group_ids()
    ))
  )
);

CREATE POLICY graph_memories_update ON graph_memories
FOR UPDATE USING (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    owner_npub = NULLIF(current_setting('app.user_npub', true), '')
    OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
    OR EXISTS (
      SELECT 1
      FROM graph_memory_acl acl
      WHERE acl.memory_id = graph_memories.id
        AND acl.access IN ('write', 'owner')
        AND (
          acl.principal_npub = NULLIF(current_setting('app.user_npub', true), '')
          OR acl.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
          OR (acl.group_id IS NOT NULL AND graph_has_group(acl.group_id))
        )
    )
  )
);
```

The implementation should add matching policies for `graph_memory_acl`, `graph_entities`, and `graph_memory_entities`, or only mutate those tables through `SECURITY DEFINER` functions that validate visible memory IDs.

### Roles And Grants

Bootstrap should create:

```sql
CREATE ROLE tower_graph_owner NOLOGIN;
CREATE ROLE tower_graph_app LOGIN PASSWORD '...';

ALTER TABLE graph_memories OWNER TO tower_graph_owner;
ALTER TABLE graph_memory_acl OWNER TO tower_graph_owner;
ALTER TABLE graph_entities OWNER TO tower_graph_owner;
ALTER TABLE graph_memory_entities OWNER TO tower_graph_owner;

GRANT USAGE ON SCHEMA public TO tower_graph_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_memories TO tower_graph_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_memory_acl TO tower_graph_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_entities TO tower_graph_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_memory_entities TO tower_graph_app;
```

Do not grant `BYPASSRLS`. Do not make `tower_graph_app` the table owner.

## AGE Graph Usage

Use AGE for traversal and relationship modeling, but keep IDs and ACL metadata tied back to relational authority rows.

Possible AGE labels:

```text
(:Memory {memory_id, workspace_owner_npub, owner_npub, actor_npub, group_id})
(:Person {npub})
(:Agent {npub})
(:Group {group_id})
(:Topic {name})
(:Entity {type, name})
```

Possible edges:

```text
(:Person)-[:OWNS]->(:Memory)
(:Agent)-[:REMEMBERS]->(:Memory)
(:Memory)-[:VISIBLE_TO_GROUP]->(:Group)
(:Memory)-[:ABOUT]->(:Topic)
(:Memory)-[:MENTIONS]->(:Entity)
(:Memory)-[:RELATED_TO]->(:Memory)
```

Important unresolved detail: before relying on AGE labels/edge tables as an RLS boundary, we must verify how RLS behaves through AGE's Cypher functions and generated label tables. A safer first version is:

1. Use RLS relational tables to resolve visible memory IDs.
2. Use AGE traversal only within the visible ID set.
3. Return only rows that pass final relational RLS checks.

### AGE Bootstrap

Migration should create the AGE graph if it does not exist:

```sql
SELECT create_graph('tower_memory');
```

Implementation note: AGE graph creation may need to be wrapped in a `DO` block or guarded by catalog checks because `create_graph` errors if the graph already exists.

For phase 4, write helper functions:

```sql
graph_upsert_memory_vertex(memory_id uuid)
graph_upsert_entity_vertex(entity_id uuid)
graph_upsert_memory_entity_edge(memory_id uuid, entity_id uuid, relation text)
```

These can be `SECURITY DEFINER` functions owned by `tower_graph_owner` only if they validate the caller has access to the underlying RLS row first.

## API Surface

Avoid a generic `/cypher` endpoint initially. Start with allowlisted graph operations.

Candidate routes:

```http
POST /api/v4/graph/memories
GET  /api/v4/graph/memories
POST /api/v4/graph/search
POST /api/v4/graph/neighborhood
POST /api/v4/graph/facts
```

Example memory write:

```json
{
  "workspace_owner_npub": "npub...",
  "visibility": "group",
  "group_id": "stable-group-uuid",
  "memory_type": "preference",
  "title": "Release notes preference",
  "summary": "Operator prefers concrete release notes with command output.",
  "body_ciphertext": "nip44-or-workspace-encrypted-payload",
  "entities": [
    { "type": "project", "name": "wingman-tower" }
  ],
  "topics": ["release-process", "documentation"]
}
```

Example search:

```json
{
  "workspace_owner_npub": "npub...",
  "query": "release note preferences",
  "scope": {
    "personal": true,
    "agent": true,
    "groups": ["stable-group-uuid"],
    "apps": ["npub1app..."]
  }
}
```

Tower should narrow requested scopes to what the authenticated principal can actually access.

### Concrete First API

First implementation should ship only:

```http
POST /api/v4/graph/memories
GET  /api/v4/graph/memories
GET  /api/v4/graph/memories/:memoryId
```

Delay graph traversal routes until relational RLS tests are solid.

#### POST `/api/v4/graph/memories`

Request:

```json
{
  "workspace_owner_npub": "npub...",
  "visibility": "agent",
  "actor_npub": "npub...",
  "source_app_npub": "npub...",
  "memory_type": "preference",
  "title": "Preferred release note style",
  "summary": "Prefers concise release notes with exact commands.",
  "body_ciphertext": "ciphertext",
  "metadata": {},
  "entities": [
    { "entity_type": "project", "entity_key": "wingman-tower", "display_name": "Wingman Tower", "relation": "mentions" }
  ],
  "acl": [
    { "group_id": "uuid", "access": "read" }
  ]
}
```

Rules:

- `workspace_owner_npub` is required for group/workspace memory and must match a visible workspace; it is optional for personal/agent memory.
- `visibility` is required.
- `body_ciphertext` is required for phase 1; plaintext body is not accepted.
- `summary`, `title`, and `entities` are cleartext and must be treated as potentially sensitive.
- `visibility = personal` requires `owner_npub = resolved user_npub`.
- `visibility = agent` requires `actor_npub = resolved actor_npub`; agent-owned memory should usually be signed directly by that agent npub.
- `visibility = group` requires `group_id` in resolved group membership.
- `source_app_npub`, if supplied, requires `workspace_owner_npub` and must be a registered app namespace for that workspace.
- `visibility = workspace` is initially admin-group only unless product policy says otherwise.

Response:

```json
{
  "memory": {
    "id": "uuid",
    "workspace_owner_npub": "npub...",
    "visibility": "agent",
    "actor_npub": "npub...",
    "memory_type": "preference",
    "title": "Preferred release note style",
    "summary": "Prefers concise release notes with exact commands.",
    "body_ciphertext": "ciphertext",
    "metadata": {},
    "created_by_npub": "npub...",
    "created_at": "2026-05-05T00:00:00.000Z",
    "updated_at": "2026-05-05T00:00:00.000Z"
  }
}
```

#### GET `/api/v4/graph/memories`

Query params:

```text
workspace_owner_npub optional
visibility optional
memory_type optional
owner_npub optional
actor_npub optional
agent_npub optional
source_app_npub optional
group_id optional
limit optional default 100 max 500
offset optional default 0
```

Tower passes filters to graph DB. RLS is still responsible for final row visibility.

Response:

```json
{
  "memories": [],
  "total": 0,
  "limit": 100,
  "offset": 0,
  "has_more": false
}
```

#### GET `/api/v4/graph/memories/:memoryId`

Returns one visible memory or `404`. Do not leak whether an inaccessible memory exists.

### Route Wiring

Add `graphRouter` to `src/routes/graph.ts` and mount in `src/server.ts`:

```ts
app.route('/api/v4/graph', graphRouter);
```

OpenAPI must document the routes and error codes:

- `400` invalid request;
- `401` missing NIP-98;
- `403` authenticated but not allowed to use requested scope;
- `404` graph disabled or memory not visible;
- `501` graph feature disabled, if we prefer explicit disabled semantics.

### Auth Resolution Helper

Add a graph-specific helper that composes existing Tower auth behavior:

```ts
type GraphIdentityContext = {
  signerNpub: string;
  userNpub: string;
  actorNpub: string;
  sourceAppNpub: string | null;
  workspaceOwnerNpub: string | null;
  groupIds: string[];
};
```

Resolution steps:

1. `requireNip98AuthResolved(c)` gets `signerNpub` and `userNpub`.
2. Resolve `actorNpub`; default to the signer for agent-owned memory.
3. Require at least one of `signerNpub`, `userNpub`, or `actorNpub` to be in `GRAPH_ALLOWED_NPUBS`.
4. If request supplies `workspace_owner_npub`, validate that workspace is visible to `userNpub` or the resolved effective principal using `listWorkspacesForMember`.
5. Resolve group IDs for that workspace from `v4_group_members` for the effective principal when workspace context is present.
6. If request supplies `source_app_npub`, require `workspace_owner_npub` and require the app exists in `workspace_apps` for that workspace.
7. If request supplies `actor_npub` different from both `signerNpub` and `userNpub`, require an explicit delegation record before accepting it. If no delegation table exists yet, reject this case.
8. Pass the resolved context to the graph DB transaction helper.

Initial implementation should not allow arbitrary `actor_npub` impersonation. Agent-owned memory should usually be signed directly by that agent npub.

### Graph Transaction Helper

`src/graph/session.ts` should expose:

```ts
export async function withGraphIdentity<T>(
  ctx: GraphIdentityContext,
  fn: (sql: ReturnType<typeof getGraphDb>) => Promise<T>,
): Promise<T>
```

Inside a transaction:

```ts
await tx`SET LOCAL row_security = on`;
await tx`SET LOCAL app.workspace_owner_npub = ${ctx.workspaceOwnerNpub || ''}`;
await tx`SET LOCAL app.signer_npub = ${ctx.signerNpub}`;
await tx`SET LOCAL app.user_npub = ${ctx.userNpub}`;
await tx`SET LOCAL app.actor_npub = ${ctx.actorNpub}`;
await tx`SET LOCAL app.source_app_npub = ${ctx.sourceAppNpub || ''}`;
await tx`SET LOCAL app.group_ids = ${JSON.stringify(ctx.groupIds)}`;
return fn(tx);
```

## Encryption And Storage

There are two plausible memory payload modes:

1. Plaintext graph metadata, encrypted body.
2. Fully encrypted memory payload, with only minimal cleartext indexing.

For shared/team memory, group encryption should mirror Tower records:

- clear ACL metadata uses stable `group_id`;
- encrypted payloads are wrapped to group keys;
- rotating `group_npub`/epoch remain crypto metadata;
- removed members lose access to future graph memories after group epoch rotation.

For personal memory, encrypt to the writer's npub. For agent-private memory, the writer is the agent npub, so encrypt to the agent key. If human recovery is required, add an explicit secondary encrypted payload for the owning/recovery user; do not assume workspace admins can decrypt agent memory.

Build rule for phase 1: require `body_ciphertext`; allow optional cleartext `title`, `summary`, and `entities` only because graph retrieval needs some inspectable index. Clients must decide what is safe to reveal in those fields.

If a caller wants no cleartext memory content, it can omit `title`, `summary`, and `entities`; the memory will still be retrievable by owner/scope filters but not useful for semantic graph search.

Future phase: add embeddings/vector indexes only after we have a clear encryption and sensitivity policy.

## Initial Implementation Phases

### Markdown Docs Projection

Tower graph should remain the canonical store for graph-backed docs, memory, relationships, history, and ACL. Repo-local markdown is a generated working projection for humans and agents.

The companion design in `docs/tower_managed_docs.md` defines the convention:

- a repo opts in with `.wingman-tower.yml`;
- when opted in, `docs/` is Tower-managed;
- local edits under `docs/` are disposable and may be overwritten;
- durable edits go through Tower/Yoke APIs or a Wingman skill;
- `docs/` should be added to `.gitignore`;
- Tower stores the graph relationships, document versions, permissions, and history.

This keeps the useful agent surface of repo-near markdown without making local files a second graph database.

### Phase 1: Optional Graph DB

- Add graph Postgres/AGE Docker service.
- Add Tower config/env validation.
- Add `GRAPH_ALLOWED_NPUBS` and route-level allowlist enforcement.
- Add graph DB migration runner.
- Add health/status output for graph availability.
- Add no-op disabled route behavior.

### Phase 2: RLS Authority Tables

- Create `graph_memories` and ACL tables.
- Add RLS policies.
- Add Tower transaction helper that sets `app.*` identity settings.
- Add tests proving user/agent/group isolation.

### Phase 3: Allowlisted Memory API

- Add create/list/get routes.
- Validate NIP-98, workspace keys, app keys, and group membership through existing Tower auth paths.
- Store encrypted payloads and clear minimal metadata.
- Add OpenAPI entries.

### Phase 4: AGE Traversal

- Create AGE graph.
- Mirror memory/entity/topic/group vertices and edges.
- Add neighborhood and related-memory queries.
- Verify final results against RLS-protected relational memory rows.

### Phase 5: Agent Integration

- Add agent memory write/read helpers.
- Add source app attribution where useful.
- Add admin/inspection UI for counts and storage, not decrypted memory content.

## Test Plan

Add `tests/graph.test.ts` with an isolated Postgres test DB for graph. If AGE is not available in CI, split tests:

- `tests/graph-rls.test.ts`: pure Postgres relational/RLS tests;
- `tests/graph-age.test.ts`: AGE integration tests behind `GRAPH_AGE_TESTS=true`.

Required tests:

1. `GRAPH_ENABLED=false` makes graph routes unavailable.
2. Non-allowlisted npubs cannot use graph routes.
3. Graph migrations create tables, policies, and non-owner app role.
4. An allowlisted agent can create and read its own `agent` memory.
5. A different allowlisted agent cannot read that agent memory.
6. A user can create and read their own `personal` memory.
7. A different user cannot read that personal memory.
8. A user can create `group` memory only for a group they belong to.
9. Current group members can read group memory.
10. Non-members cannot read group memory.
11. `source_app_npub` attribution requires a registered workspace app namespace.
12. Workspace session key requests resolve to real `user_npub`.
13. Supplying arbitrary `actor_npub` without delegation is rejected.
14. `GET /memories/:id` returns `404`, not `403`, for inaccessible memories.
15. The graph app DB role cannot bypass RLS.
16. `title`/`summary` can be omitted and body ciphertext remains required.

API tests should use the same NIP-98 test helpers as `tests/groups.test.ts`. Avoid coupling graph tests to billing behavior.

## Build Checklist

Implementation is build-ready when these are complete:

- [ ] Pin or build an AGE-enabled Postgres 16 image.
- [ ] Add `graph-postgres` to `docker-compose.prod.yml`.
- [ ] Add graph env vars to `.env.example` and production docs.
- [ ] Add `config.graph` to `src/config.ts`.
- [ ] Add `GRAPH_ALLOWED_NPUBS` config and route guard.
- [ ] Add graph DB admin/app connection helpers.
- [ ] Add `bun run graph:init`.
- [ ] Update `docker/entrypoint.sh` to run graph migrations when enabled.
- [ ] Add `001_graph_init.sql` with extension, roles, tables, RLS, indexes.
- [ ] Add graph identity transaction helper.
- [ ] Add create/list/get memory service methods.
- [ ] Add graph router and mount it.
- [ ] Add OpenAPI schemas/routes.
- [ ] Add tests for disabled mode, auth, RLS, group isolation, source app attribution, workspace keys.
- [ ] Update `/health` or add `/api/v4/graph/status`.
- [ ] Add backup/restore notes for `tower-graph-postgres-data`.

## Backup / Restore

Graph DB must be backed up separately from the primary Tower DB. In the first build this is self-hosted, private, operator-owned infrastructure; there is no public billing account attached to graph memory.

Minimum production note:

```sh
docker exec wingman-tower-graph-postgres pg_dump \
  -U "$GRAPH_DB_ADMIN_USER" \
  -d "$GRAPH_DB_NAME" \
  --format=custom \
  > tower-graph.dump
```

Restore should recreate the AGE extension and graph schema before loading data if needed. Document exact commands after the final image/tag is chosen.

## Risks

- AGE/RLS behavior through Cypher may not be sufficient as the only isolation layer.
- Cleartext graph metadata can leak sensitive facts even if bodies are encrypted.
- Group removal and epoch rotation semantics must be consistent with Tower record sync.
- Workspace session keys and agent keys need explicit resolution rules or memories may be attributed to the wrong principal.
- Allowlist membership grants use of the infra, not group access; group membership and key epoch revocation still need separate enforcement.
- Agent memory ownership must remain npub-centric or workspace admins may accidentally become privileged over personal agent graphs.

## Open Questions

- Do we need a separate delegation/audit table that maps `actor_npub` agent identities to an operator/user, even without billing?
- How do we model a spouse/family/shared agent that has access to some shared memories but not personal memories?
- Should group memory be readable by all current group members, or only members with a specific `graph_memory` capability? Current decision: all current group members can read.
- Do we need per-memory write locks/checkouts similar to document records?
- How will graph data be exported/imported as part of a portable Tower backend?
- Which exact digest of `apache/age:release_PG16_1.6.0` do we want to pin for production?
- Do we need a new Tower table for agent delegation before allowing `actor_npub != signer_npub`?

## Current Recommendation

Build this as an optional separate AGE-enabled Postgres service managed by a self-hosted Tower. Gate graph routes with `GRAPH_ALLOWED_NPUBS`, use relational RLS tables as the hard security boundary, and treat AGE as a traversal/indexing layer behind allowlisted Tower APIs. Do not expose direct Cypher to agents until we have proven AGE label/edge RLS behavior and have a safe query sandbox.
