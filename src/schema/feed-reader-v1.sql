-- Include reader authority in the bounded journal authorization projection.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_context(r JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('scope_id',r->'scope_id','channel_id',r->'channel_id',
 'owner_actor_id',r->'owner_actor_id','viewer_actor_id',r->'viewer_actor_id','reader_actor_id',r->'reader_actor_id',
 'resource_type',r->'resource_type','resource_id',r->'resource_id',
 'task_id',r->'task_id','doc_id',r->'doc_id','thread_id',r->'thread_id')
$$;
-- Personal reader metadata only; publishing tables and grants are untouched.
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_subscriptions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 reader_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 source JSONB NOT NULL CHECK(source->>'kind' IN ('wapp','public')),
 source_key JSONB NOT NULL,
 title TEXT CHECK(title IS NULL OR length(title)<=256),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','unsubscribed')),
 row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(workspace_id,reader_actor_id,source_key), UNIQUE(workspace_id,reader_actor_id,id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_item_states (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
 workspace_id UUID NOT NULL, reader_actor_id UUID NOT NULL, subscription_id UUID NOT NULL,
 item_id TEXT NOT NULL CHECK(length(item_id)>0 AND octet_length(item_id)<=2048),
 read BOOLEAN NOT NULL DEFAULT FALSE, dismissed BOOLEAN NOT NULL DEFAULT FALSE, saved BOOLEAN NOT NULL DEFAULT FALSE,
 row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(workspace_id,reader_actor_id,subscription_id) REFERENCES flightdeck_pg_feed_subscriptions(workspace_id,reader_actor_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,reader_actor_id,subscription_id,item_id)
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_mutations (
 workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE, reader_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id),
 mutation_id UUID NOT NULL, request_hash TEXT NOT NULL, acknowledgement JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(workspace_id,reader_actor_id,mutation_id)
);
-- Cursors store scoped positions, never feed contents. Preferences and flags do not expire.
CREATE TABLE IF NOT EXISTS flightdeck_pg_feed_cursors (
 token UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE,
 reader_actor_id UUID NOT NULL REFERENCES flightdeck_pg_actors(id), route TEXT NOT NULL, after_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feed_subscription_reader ON flightdeck_pg_feed_subscriptions(workspace_id,reader_actor_id,id);
CREATE INDEX IF NOT EXISTS idx_feed_state_reader ON flightdeck_pg_feed_item_states(workspace_id,reader_actor_id,subscription_id,id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_feed_subscription') THEN
 CREATE TRIGGER fd_record_feed_subscription AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_feed_subscriptions
 FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('feed_subscription');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_feed_item_state') THEN
 CREATE TRIGGER fd_record_feed_item_state AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_feed_item_states
 FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('feed_item_state');
 END IF;
END $$;
-- Refresh stored generated context only if upgrading rows written before this projection.
UPDATE flightdeck_pg_record_current SET row=row WHERE family IN ('feed_subscription','feed_item_state') AND NOT context ? 'reader_actor_id';
UPDATE flightdeck_pg_record_journal SET row=row WHERE family IN ('feed_subscription','feed_item_state') AND NOT context ? 'reader_actor_id';
