-- Upgrade-only fixture. Never execute on a managed database.
CREATE TABLE IF NOT EXISTS flightdeck_pg_canvas_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  canvas_id UUID NOT NULL,
  anchor_type TEXT NOT NULL,
  anchor_naplet_id UUID,
  anchor JSONB NOT NULL DEFAULT '{"x":0,"y":0}'::jsonb,
  parent_comment_id UUID,
  body TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by_actor_id UUID,
  created_by_actor_id UUID NOT NULL,
  updated_by_actor_id UUID NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, canvas_id) REFERENCES flightdeck_pg_canvases(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, canvas_id, anchor_naplet_id) REFERENCES flightdeck_pg_canvas_naplets(workspace_id, canvas_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, canvas_id, parent_comment_id) REFERENCES flightdeck_pg_canvas_comments(workspace_id, canvas_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by_actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, updated_by_actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, resolved_by_actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT,
  CHECK (anchor_type IN ('canvas', 'naplet')),
  CHECK ((anchor_type = 'canvas' AND anchor_naplet_id IS NULL) OR (anchor_type = 'naplet' AND anchor_naplet_id IS NOT NULL)),
  CHECK (jsonb_typeof(anchor) = 'object'),
  CHECK (length(trim(body)) > 0 AND length(body) <= 10000),
  CHECK (row_version >= 1),
  UNIQUE (workspace_id, canvas_id, id)
);
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_canvas_comments_canvas
  ON flightdeck_pg_canvas_comments(workspace_id, canvas_id, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flightdeck_pg_canvas_comments_parent
  ON flightdeck_pg_canvas_comments(workspace_id, canvas_id, parent_comment_id, created_at, id)
  WHERE deleted_at IS NULL;
