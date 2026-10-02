-- Context structure belongs to one scope; target content has no cascade/FK here.
CREATE TABLE IF NOT EXISTS flightdeck_pg_context_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 256),
  parent_id UUID,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (workspace_id, scope_id, id),
  FOREIGN KEY (workspace_id, scope_id) REFERENCES flightdeck_pg_scopes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, scope_id, parent_id)
    REFERENCES flightdeck_pg_context_components(workspace_id, scope_id, id) ON DELETE RESTRICT,
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS idx_fd_context_components_active
  ON flightdeck_pg_context_components(workspace_id, scope_id, parent_id, sort_order, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_context_components_page
  ON flightdeck_pg_context_components(workspace_id, scope_id, sort_order, id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS flightdeck_pg_context_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL,
  component_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('doc', 'file', 'task', 'artifact')),
  target JSONB NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, scope_id, component_id)
    REFERENCES flightdeck_pg_context_components(workspace_id, scope_id, id) ON DELETE CASCADE,
  CHECK (
    (target_type IN ('doc','file','task')
      AND target = jsonb_build_object('record_id', target->>'record_id')
      AND COALESCE(target->>'record_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (target_type = 'artifact' AND COALESCE(
      target = jsonb_build_object('origin',target->>'origin','project',target->>'project',
        'artifact',target->>'artifact','page','index.html','version_policy','latest')
      AND target->>'origin' ~ '^https?://[^/@?#[:space:]]+$'
      AND target->>'project' ~ '^[A-Za-z0-9_-]{1,128}$'
      AND target->>'artifact' ~ '^[A-Za-z0-9_-]{1,128}$', FALSE))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fd_context_reference_target_active
  ON flightdeck_pg_context_references(workspace_id, component_id, target_type, target) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fd_context_references_active
  ON flightdeck_pg_context_references(workspace_id, scope_id, component_id, sort_order, id) WHERE deleted_at IS NULL;
