CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  graph_name text := COALESCE(NULLIF(current_setting('app.graph_name', true), ''), 'tower_memory');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS age';

    BEGIN
      EXECUTE 'LOAD ''age''';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'AGE extension installed but LOAD failed: %', SQLERRM;
    END;

    IF to_regproc('ag_catalog.create_graph') IS NOT NULL
      AND to_regclass('ag_catalog.ag_graph') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = graph_name)
    THEN
      EXECUTE format('SELECT ag_catalog.create_graph(%L)', graph_name);
    END IF;
  ELSE
    RAISE NOTICE 'Apache AGE extension is not available; skipping AGE graph creation';
  END IF;
END
$$;

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
  body_ciphertext text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group', 'workspace')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null)
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

CREATE INDEX IF NOT EXISTS idx_graph_memory_acl_principal
  ON graph_memory_acl(principal_npub, access);

CREATE INDEX IF NOT EXISTS idx_graph_memory_acl_actor
  ON graph_memory_acl(actor_npub, access);

CREATE INDEX IF NOT EXISTS idx_graph_memory_acl_group
  ON graph_memory_acl(group_id, access);

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

CREATE TABLE IF NOT EXISTS graph_import_runs (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  source text not null,
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  source_app_npub text,
  group_id uuid,
  visibility text not null,
  status text not null default 'completed',
  nodes_upserted integer not null default 0,
  edges_upserted integer not null default 0,
  schema_upserted integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group')),
  check (status in ('pending', 'running', 'completed', 'failed')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null)
    or (visibility = 'agent' and actor_npub is not null and group_id is null)
    or (visibility = 'group' and group_id is not null and workspace_owner_npub is not null)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_import_runs_scope_unique
  ON graph_import_runs(
    visibility,
    COALESCE(workspace_owner_npub, ''),
    COALESCE(owner_npub, ''),
    COALESCE(actor_npub, ''),
    COALESCE(group_id::text, ''),
    source,
    run_id
  );

CREATE INDEX IF NOT EXISTS idx_graph_import_runs_actor
  ON graph_import_runs(actor_npub, source, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_import_runs_group
  ON graph_import_runs(workspace_owner_npub, group_id, source, updated_at desc);

CREATE TABLE IF NOT EXISTS graph_repository_checkpoints (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  corpus_id text not null,
  repository_id text not null,
  head_sha text not null,
  schema_version text not null,
  parser_metadata jsonb not null default '{}'::jsonb,
  index_metadata jsonb not null default '{}'::jsonb,
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  source_app_npub text,
  group_id uuid,
  visibility text not null,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null)
    or (visibility = 'agent' and actor_npub is not null and group_id is null)
    or (visibility = 'group' and group_id is not null and workspace_owner_npub is not null)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_repository_checkpoints_scope
  ON graph_repository_checkpoints(
    visibility,
    COALESCE(workspace_owner_npub, ''),
    COALESCE(owner_npub, ''),
    COALESCE(actor_npub, ''),
    COALESCE(group_id::text, ''),
    source,
    corpus_id,
    repository_id
  );

CREATE TABLE IF NOT EXISTS graph_schema_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id text,
  source text not null,
  schema_kind text not null default 'property_graph',
  schema jsonb not null default '{}'::jsonb,
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  source_app_npub text,
  group_id uuid,
  visibility text not null,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null)
    or (visibility = 'agent' and actor_npub is not null and group_id is null)
    or (visibility = 'group' and group_id is not null and workspace_owner_npub is not null)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_schema_snapshots_scope_unique
  ON graph_schema_snapshots(
    visibility,
    COALESCE(workspace_owner_npub, ''),
    COALESCE(owner_npub, ''),
    COALESCE(actor_npub, ''),
    COALESCE(group_id::text, ''),
    source,
    COALESCE(run_id, ''),
    schema_kind
  );

CREATE TABLE IF NOT EXISTS graph_nodes (
  id uuid primary key default gen_random_uuid(),
  external_id text not null,
  source text not null,
  run_id text,
  node_type text,
  labels text[] not null default '{}',
  properties jsonb not null default '{}'::jsonb,
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  source_app_npub text,
  group_id uuid,
  visibility text not null,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null)
    or (visibility = 'agent' and actor_npub is not null and group_id is null)
    or (visibility = 'group' and group_id is not null and workspace_owner_npub is not null)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_scope_external
  ON graph_nodes(
    visibility,
    COALESCE(workspace_owner_npub, ''),
    COALESCE(owner_npub, ''),
    COALESCE(actor_npub, ''),
    COALESCE(group_id::text, ''),
    source,
    external_id
  );

CREATE INDEX IF NOT EXISTS idx_graph_nodes_actor
  ON graph_nodes(actor_npub, source, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_group
  ON graph_nodes(workspace_owner_npub, group_id, source, updated_at desc);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_labels
  ON graph_nodes USING gin(labels);

CREATE TABLE IF NOT EXISTS graph_node_labels (
  node_id uuid not null references graph_nodes(id) on delete cascade,
  label text not null,
  primary key (node_id, label)
);

CREATE INDEX IF NOT EXISTS idx_graph_node_labels_label
  ON graph_node_labels(label);

CREATE TABLE IF NOT EXISTS graph_edges (
  id uuid primary key default gen_random_uuid(),
  external_id text not null,
  source text not null,
  run_id text,
  source_node_id uuid not null references graph_nodes(id) on delete cascade,
  target_node_id uuid not null references graph_nodes(id) on delete cascade,
  relationship_type text not null,
  properties jsonb not null default '{}'::jsonb,
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  source_app_npub text,
  group_id uuid,
  visibility text not null,
  created_by_npub text not null,
  updated_by_npub text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility in ('personal', 'agent', 'group')),
  check (
    (visibility = 'personal' and owner_npub is not null and group_id is null)
    or (visibility = 'agent' and actor_npub is not null and group_id is null)
    or (visibility = 'group' and group_id is not null and workspace_owner_npub is not null)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_scope_external
  ON graph_edges(
    visibility,
    COALESCE(workspace_owner_npub, ''),
    COALESCE(owner_npub, ''),
    COALESCE(actor_npub, ''),
    COALESCE(group_id::text, ''),
    source,
    external_id
  );

CREATE INDEX IF NOT EXISTS idx_graph_edges_source_node
  ON graph_edges(source_node_id, relationship_type);

CREATE INDEX IF NOT EXISTS idx_graph_edges_target_node
  ON graph_edges(target_node_id, relationship_type);

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

CREATE OR REPLACE FUNCTION graph_scope_visible(
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  group_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    (
      workspace_owner_npub IS NULL
      OR NULLIF(current_setting('app.workspace_owner_npub', true), '') IS NULL
      OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
    )
    AND (
      owner_npub = NULLIF(current_setting('app.user_npub', true), '')
      OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
      OR (group_id IS NOT NULL AND graph_has_group(group_id))
    )
$$;

CREATE OR REPLACE FUNCTION graph_scope_writable(
  visibility text,
  workspace_owner_npub text,
  owner_npub text,
  actor_npub text,
  group_id uuid,
  write_npub text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    (
      workspace_owner_npub IS NULL
      OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
    )
    AND write_npub IN (
      NULLIF(current_setting('app.user_npub', true), ''),
      NULLIF(current_setting('app.actor_npub', true), '')
    )
    AND (
      (visibility = 'personal' AND owner_npub = NULLIF(current_setting('app.user_npub', true), ''))
      OR (visibility = 'agent' AND actor_npub = NULLIF(current_setting('app.actor_npub', true), ''))
      OR (visibility = 'group' AND group_id IS NOT NULL AND graph_has_group(group_id))
    )
$$;

ALTER TABLE graph_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_memories FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_memory_acl ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_memory_acl FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_memory_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_memory_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_import_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_repository_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_repository_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_schema_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_schema_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_node_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_node_labels FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_memories_select ON graph_memories;
CREATE POLICY graph_memories_select ON graph_memories
FOR SELECT USING (
  (
    workspace_owner_npub IS NULL
    OR NULLIF(current_setting('app.workspace_owner_npub', true), '') IS NULL
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

DROP POLICY IF EXISTS graph_memories_insert ON graph_memories;
CREATE POLICY graph_memories_insert ON graph_memories
FOR INSERT WITH CHECK (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND created_by_npub IN (
    NULLIF(current_setting('app.user_npub', true), ''),
    NULLIF(current_setting('app.actor_npub', true), '')
  )
  AND (
    (visibility = 'personal' AND owner_npub = NULLIF(current_setting('app.user_npub', true), ''))
    OR (visibility = 'agent' AND actor_npub = NULLIF(current_setting('app.actor_npub', true), ''))
    OR (visibility = 'group' AND group_id IS NOT NULL AND graph_has_group(group_id))
    OR (visibility = 'workspace' AND workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), ''))
  )
);

DROP POLICY IF EXISTS graph_memories_update ON graph_memories;
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
) WITH CHECK (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND updated_by_npub IN (
    NULLIF(current_setting('app.user_npub', true), ''),
    NULLIF(current_setting('app.actor_npub', true), '')
  )
);

DROP POLICY IF EXISTS graph_memories_delete ON graph_memories;
CREATE POLICY graph_memories_delete ON graph_memories
FOR DELETE USING (
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
        AND acl.access = 'owner'
        AND (
          acl.principal_npub = NULLIF(current_setting('app.user_npub', true), '')
          OR acl.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
          OR (acl.group_id IS NOT NULL AND graph_has_group(acl.group_id))
        )
    )
  )
);

DROP POLICY IF EXISTS graph_memory_acl_select ON graph_memory_acl;
CREATE POLICY graph_memory_acl_select ON graph_memory_acl
FOR SELECT USING (
  principal_npub = NULLIF(current_setting('app.user_npub', true), '')
  OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
  OR (group_id IS NOT NULL AND graph_has_group(group_id))
);

DROP POLICY IF EXISTS graph_memory_acl_insert ON graph_memory_acl;
CREATE POLICY graph_memory_acl_insert ON graph_memory_acl
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1
    FROM graph_memories memory
    WHERE memory.id = graph_memory_acl.memory_id
      AND (
        memory.owner_npub = NULLIF(current_setting('app.user_npub', true), '')
        OR memory.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
        OR (
          graph_memory_acl.access IN ('read', 'write')
          AND graph_memory_acl.group_id IS NOT NULL
          AND graph_has_group(graph_memory_acl.group_id)
        )
      )
  )
);

DROP POLICY IF EXISTS graph_memory_acl_update ON graph_memory_acl;
CREATE POLICY graph_memory_acl_update ON graph_memory_acl
FOR UPDATE USING (
  principal_npub = NULLIF(current_setting('app.user_npub', true), '')
  OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
  OR (group_id IS NOT NULL AND graph_has_group(group_id))
) WITH CHECK (
  principal_npub = NULLIF(current_setting('app.user_npub', true), '')
  OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
  OR (group_id IS NOT NULL AND graph_has_group(group_id))
);

DROP POLICY IF EXISTS graph_memory_acl_delete ON graph_memory_acl;
CREATE POLICY graph_memory_acl_delete ON graph_memory_acl
FOR DELETE USING (
  principal_npub = NULLIF(current_setting('app.user_npub', true), '')
  OR actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
  OR (group_id IS NOT NULL AND graph_has_group(group_id))
);

DROP POLICY IF EXISTS graph_entities_select ON graph_entities;
CREATE POLICY graph_entities_select ON graph_entities
FOR SELECT USING (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    NULLIF(current_setting('app.user_npub', true), '') IS NOT NULL
    OR NULLIF(current_setting('app.actor_npub', true), '') IS NOT NULL
    OR EXISTS (SELECT 1 FROM graph_current_group_ids())
  )
);

DROP POLICY IF EXISTS graph_entities_insert ON graph_entities;
CREATE POLICY graph_entities_insert ON graph_entities
FOR INSERT WITH CHECK (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    NULLIF(current_setting('app.user_npub', true), '') IS NOT NULL
    OR NULLIF(current_setting('app.actor_npub', true), '') IS NOT NULL
  )
);

DROP POLICY IF EXISTS graph_entities_update ON graph_entities;
CREATE POLICY graph_entities_update ON graph_entities
FOR UPDATE USING (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    NULLIF(current_setting('app.user_npub', true), '') IS NOT NULL
    OR NULLIF(current_setting('app.actor_npub', true), '') IS NOT NULL
  )
) WITH CHECK (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    NULLIF(current_setting('app.user_npub', true), '') IS NOT NULL
    OR NULLIF(current_setting('app.actor_npub', true), '') IS NOT NULL
  )
);

DROP POLICY IF EXISTS graph_entities_delete ON graph_entities;
CREATE POLICY graph_entities_delete ON graph_entities
FOR DELETE USING (
  (
    workspace_owner_npub IS NULL
    OR workspace_owner_npub = NULLIF(current_setting('app.workspace_owner_npub', true), '')
  )
  AND (
    NULLIF(current_setting('app.user_npub', true), '') IS NOT NULL
    OR NULLIF(current_setting('app.actor_npub', true), '') IS NOT NULL
  )
);

DROP POLICY IF EXISTS graph_memory_entities_select ON graph_memory_entities;
CREATE POLICY graph_memory_entities_select ON graph_memory_entities
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM graph_memories memory
    WHERE memory.id = graph_memory_entities.memory_id
  )
);

DROP POLICY IF EXISTS graph_memory_entities_insert ON graph_memory_entities;
CREATE POLICY graph_memory_entities_insert ON graph_memory_entities
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM graph_memories memory
    WHERE memory.id = graph_memory_entities.memory_id
      AND (
        memory.owner_npub = NULLIF(current_setting('app.user_npub', true), '')
        OR memory.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
        OR (memory.group_id IS NOT NULL AND graph_has_group(memory.group_id))
      )
  )
);

DROP POLICY IF EXISTS graph_memory_entities_update ON graph_memory_entities;
CREATE POLICY graph_memory_entities_update ON graph_memory_entities
FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM graph_memories memory
    WHERE memory.id = graph_memory_entities.memory_id
      AND (
        memory.owner_npub = NULLIF(current_setting('app.user_npub', true), '')
        OR memory.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
        OR (memory.group_id IS NOT NULL AND graph_has_group(memory.group_id))
      )
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM graph_memories memory
    WHERE memory.id = graph_memory_entities.memory_id
      AND (
        memory.owner_npub = NULLIF(current_setting('app.user_npub', true), '')
        OR memory.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
        OR (memory.group_id IS NOT NULL AND graph_has_group(memory.group_id))
      )
  )
);

DROP POLICY IF EXISTS graph_memory_entities_delete ON graph_memory_entities;
CREATE POLICY graph_memory_entities_delete ON graph_memory_entities
FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM graph_memories memory
    WHERE memory.id = graph_memory_entities.memory_id
      AND (
        memory.owner_npub = NULLIF(current_setting('app.user_npub', true), '')
        OR memory.actor_npub = NULLIF(current_setting('app.actor_npub', true), '')
        OR (memory.group_id IS NOT NULL AND graph_has_group(memory.group_id))
      )
  )
);

DROP POLICY IF EXISTS graph_import_runs_select ON graph_import_runs;
CREATE POLICY graph_import_runs_select ON graph_import_runs
FOR SELECT USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
);

DROP POLICY IF EXISTS graph_import_runs_insert ON graph_import_runs;
CREATE POLICY graph_import_runs_insert ON graph_import_runs
FOR INSERT WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, created_by_npub)
);

DROP POLICY IF EXISTS graph_import_runs_update ON graph_import_runs;
CREATE POLICY graph_import_runs_update ON graph_import_runs
FOR UPDATE USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
) WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
);

DROP POLICY IF EXISTS graph_repository_checkpoints_select ON graph_repository_checkpoints;
CREATE POLICY graph_repository_checkpoints_select ON graph_repository_checkpoints
  FOR SELECT USING (
    graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
  );

DROP POLICY IF EXISTS graph_repository_checkpoints_insert ON graph_repository_checkpoints;
CREATE POLICY graph_repository_checkpoints_insert ON graph_repository_checkpoints
  FOR INSERT WITH CHECK (
    graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, created_by_npub)
  );

DROP POLICY IF EXISTS graph_repository_checkpoints_update ON graph_repository_checkpoints;
CREATE POLICY graph_repository_checkpoints_update ON graph_repository_checkpoints
  FOR UPDATE USING (
    graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
  ) WITH CHECK (
    graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
  );

DROP POLICY IF EXISTS graph_schema_snapshots_select ON graph_schema_snapshots;
CREATE POLICY graph_schema_snapshots_select ON graph_schema_snapshots
FOR SELECT USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
);

DROP POLICY IF EXISTS graph_schema_snapshots_insert ON graph_schema_snapshots;
CREATE POLICY graph_schema_snapshots_insert ON graph_schema_snapshots
FOR INSERT WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, created_by_npub)
);

DROP POLICY IF EXISTS graph_schema_snapshots_update ON graph_schema_snapshots;
CREATE POLICY graph_schema_snapshots_update ON graph_schema_snapshots
FOR UPDATE USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
) WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
);

DROP POLICY IF EXISTS graph_nodes_select ON graph_nodes;
CREATE POLICY graph_nodes_select ON graph_nodes
FOR SELECT USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
);

DROP POLICY IF EXISTS graph_nodes_insert ON graph_nodes;
CREATE POLICY graph_nodes_insert ON graph_nodes
FOR INSERT WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, created_by_npub)
);

DROP POLICY IF EXISTS graph_nodes_update ON graph_nodes;
CREATE POLICY graph_nodes_update ON graph_nodes
FOR UPDATE USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
) WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
);

DROP POLICY IF EXISTS graph_nodes_delete ON graph_nodes;
CREATE POLICY graph_nodes_delete ON graph_nodes
FOR DELETE USING (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
);

DROP POLICY IF EXISTS graph_node_labels_select ON graph_node_labels;
CREATE POLICY graph_node_labels_select ON graph_node_labels
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM graph_nodes node
    WHERE node.id = graph_node_labels.node_id
  )
);

DROP POLICY IF EXISTS graph_node_labels_insert ON graph_node_labels;
CREATE POLICY graph_node_labels_insert ON graph_node_labels
FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM graph_nodes node
    WHERE node.id = graph_node_labels.node_id
      AND graph_scope_visible(node.workspace_owner_npub, node.owner_npub, node.actor_npub, node.group_id)
  )
);

DROP POLICY IF EXISTS graph_node_labels_delete ON graph_node_labels;
CREATE POLICY graph_node_labels_delete ON graph_node_labels
FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM graph_nodes node
    WHERE node.id = graph_node_labels.node_id
      AND graph_scope_visible(node.workspace_owner_npub, node.owner_npub, node.actor_npub, node.group_id)
  )
);

DROP POLICY IF EXISTS graph_edges_select ON graph_edges;
CREATE POLICY graph_edges_select ON graph_edges
FOR SELECT USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
);

DROP POLICY IF EXISTS graph_edges_insert ON graph_edges;
CREATE POLICY graph_edges_insert ON graph_edges
FOR INSERT WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, created_by_npub)
  AND EXISTS (SELECT 1 FROM graph_nodes node WHERE node.id = graph_edges.source_node_id)
  AND EXISTS (SELECT 1 FROM graph_nodes node WHERE node.id = graph_edges.target_node_id)
);

DROP POLICY IF EXISTS graph_edges_update ON graph_edges;
CREATE POLICY graph_edges_update ON graph_edges
FOR UPDATE USING (
  graph_scope_visible(workspace_owner_npub, owner_npub, actor_npub, group_id)
) WITH CHECK (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
  AND EXISTS (SELECT 1 FROM graph_nodes node WHERE node.id = graph_edges.source_node_id)
  AND EXISTS (SELECT 1 FROM graph_nodes node WHERE node.id = graph_edges.target_node_id)
);

DROP POLICY IF EXISTS graph_edges_delete ON graph_edges;
CREATE POLICY graph_edges_delete ON graph_edges
FOR DELETE USING (
  graph_scope_writable(visibility, workspace_owner_npub, owner_npub, actor_npub, group_id, COALESCE(updated_by_npub, created_by_npub))
);
