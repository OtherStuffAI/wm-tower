-- Actor-bound scalar preferences; reset values remain authoritative rows.
CREATE TABLE IF NOT EXISTS flightdeck_pg_private_preferences (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
 preference_key TEXT NOT NULL, value TEXT NOT NULL,
 row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,preference_key)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_private_preference_mutations (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE,
 mutation_id UUID NOT NULL, request_hash TEXT NOT NULL, acknowledgement JSONB NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,mutation_id)
);
