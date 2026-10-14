-- Extend the thread checkpoint without losing pins, receipts or tombstones.
ALTER TABLE flightdeck_pg_thread_pins ADD COLUMN IF NOT EXISTS resource_type TEXT NOT NULL DEFAULT 'thread';
ALTER TABLE flightdeck_pg_thread_pins ADD COLUMN IF NOT EXISTS resource_id UUID;
ALTER TABLE flightdeck_pg_thread_pins ALTER COLUMN thread_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION flightdeck_pg_thread_pin_capture() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM flightdeck_pg_record_emit(COALESCE(NEW.workspace_id,OLD.workspace_id),'personal_pin',
 CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
 CASE WHEN TG_OP='DELETE' THEN 'delete' ELSE 'upsert' END);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS fd_record_thread_pin ON flightdeck_pg_thread_pins;
DROP TRIGGER IF EXISTS fd_record_personal_pin ON flightdeck_pg_thread_pins;
CREATE TRIGGER fd_record_personal_pin AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_thread_pins FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_thread_pin_capture();
UPDATE flightdeck_pg_thread_pins SET resource_id=thread_id WHERE resource_id IS NULL;
ALTER TABLE flightdeck_pg_thread_pins ALTER COLUMN resource_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fd_personal_pin_target ON flightdeck_pg_thread_pins(workspace_id,actor_id,resource_type,resource_id);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fd_personal_pin_type') THEN
  ALTER TABLE flightdeck_pg_thread_pins ADD CONSTRAINT fd_personal_pin_type CHECK(resource_type IN ('thread','task','document') AND
    ((resource_type='thread' AND thread_id IS NOT NULL AND thread_id=resource_id) OR (resource_type<>'thread' AND thread_id IS NULL)));
 END IF;
END $$;
-- Current rows migrate to the new family; immutable historical journal entries
-- remain available through the legacy alias for old cursor retries.
DELETE FROM flightdeck_pg_record_current WHERE family='thread_pin' AND EXISTS(
 SELECT 1 FROM flightdeck_pg_thread_pins p WHERE p.workspace_id=flightdeck_pg_record_current.workspace_id AND p.id::text=flightdeck_pg_record_current.id);

-- Revoking membership hides private state but must not erase tombstones. A later
-- rejoin by the same canonical actor must not let stale devices resurrect pins.
ALTER TABLE flightdeck_pg_thread_pins DROP CONSTRAINT IF EXISTS flightdeck_pg_thread_pins_workspace_id_actor_id_fkey;
ALTER TABLE flightdeck_pg_thread_pin_mutations DROP CONSTRAINT IF EXISTS flightdeck_pg_thread_pin_mutations_workspace_id_actor_id_fkey;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fd_personal_pin_workspace') THEN
  ALTER TABLE flightdeck_pg_thread_pins ADD CONSTRAINT fd_personal_pin_workspace FOREIGN KEY(workspace_id) REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE;
  ALTER TABLE flightdeck_pg_thread_pins ADD CONSTRAINT fd_personal_pin_actor FOREIGN KEY(actor_id) REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE;
  ALTER TABLE flightdeck_pg_thread_pin_mutations ADD CONSTRAINT fd_personal_pin_mutation_workspace FOREIGN KEY(workspace_id) REFERENCES flightdeck_pg_workspaces(id) ON DELETE CASCADE;
  ALTER TABLE flightdeck_pg_thread_pin_mutations ADD CONSTRAINT fd_personal_pin_mutation_actor FOREIGN KEY(actor_id) REFERENCES flightdeck_pg_actors(id) ON DELETE CASCADE;
 END IF;
END $$;
