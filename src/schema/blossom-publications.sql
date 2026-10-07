CREATE TABLE IF NOT EXISTS flightdeck_pg_blossom_publications (
  workspace_id UUID NOT NULL,
  file_id UUID NOT NULL,
  version_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE CASCADE,
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, version_id, actor_id),
  FOREIGN KEY (workspace_id, file_id) REFERENCES flightdeck_pg_files(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, version_id) REFERENCES flightdeck_pg_file_versions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_blossom_publications_object
  ON flightdeck_pg_blossom_publications(storage_object_id, sha256_hex) WHERE revoked_at IS NULL;
