// Shared metadata only: deliberately no path, listing, or file-content columns.
export const driveV1Sql = `
CREATE TABLE IF NOT EXISTS flightdeck_pg_drive_shares (
 id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 owner_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 host_npub TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
 host_name TEXT NOT NULL CHECK (char_length(host_name) BETWEEN 1 AND 120),
 audience TEXT NOT NULL CHECK (audience IN ('private','workspace')),
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 revision BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drive_workspace ON flightdeck_pg_drive_shares(workspace_id);
CREATE TABLE IF NOT EXISTS flightdeck_pg_drive_proofs (
 event_id TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL
);
`;
