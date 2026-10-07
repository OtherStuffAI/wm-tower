-- Public byte consent is pinned to one attachment-link lifetime, never a new storage link.
CREATE TABLE IF NOT EXISTS flightdeck_pg_blossom_message_publications (
  workspace_id UUID NOT NULL,
  message_id UUID NOT NULL,
  link_id UUID NOT NULL REFERENCES flightdeck_pg_storage_links(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL,
  storage_object_id UUID NOT NULL REFERENCES v4_storage_objects(id) ON DELETE CASCADE,
  sha256_hex TEXT NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, link_id, actor_id),
  FOREIGN KEY (workspace_id, message_id) REFERENCES flightdeck_pg_messages(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_blossom_message_publications_object
  ON flightdeck_pg_blossom_message_publications(storage_object_id, sha256_hex) WHERE revoked_at IS NULL;
