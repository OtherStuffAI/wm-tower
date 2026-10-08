-- Personal navigation preferences; no shared scope position or authority epoch.
CREATE TABLE IF NOT EXISTS flightdeck_pg_scope_orders (
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, scope_ids UUID[] NOT NULL DEFAULT '{}',
 row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS flightdeck_pg_scope_order_mutations (
 workspace_id UUID NOT NULL, actor_id UUID NOT NULL, mutation_id UUID NOT NULL,
 request_hash TEXT NOT NULL, acknowledgement JSONB NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,mutation_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES flightdeck_pg_workspace_memberships(workspace_id,actor_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION flightdeck_pg_scope_order_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE r JSONB; BEGIN
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 r := r || jsonb_build_object('id',r->>'actor_id');
 PERFORM flightdeck_pg_record_emit((r->>'workspace_id')::uuid,'scope_order',r,CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS fd_record_scope_order ON flightdeck_pg_scope_orders;
CREATE TRIGGER fd_record_scope_order AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_scope_orders FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_scope_order_capture();
