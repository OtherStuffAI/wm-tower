-- Personal pins retain unpin tombstones; migration is insert-if-absent.
CREATE TABLE IF NOT EXISTS flightdeck_pg_thread_pins (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, thread_id UUID NOT NULL,
 channel_id UUID, root_record_id UUID, pinned BOOLEAN NOT NULL,
 pinned_at TIMESTAMPTZ, row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version > 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,actor_id,thread_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_thread_pin_mutations (
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, mutation_id UUID NOT NULL,
 request_hash TEXT NOT NULL, acknowledgement JSONB NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,mutation_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION flightdeck_pg_thread_pin_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM flightdeck_pg_record_emit(COALESCE(NEW.workspace_id,OLD.workspace_id),'thread_pin',
 CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
 CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS fd_record_thread_pin ON flightdeck_pg_thread_pins;
CREATE TRIGGER fd_record_thread_pin AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_thread_pins FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_thread_pin_capture();
