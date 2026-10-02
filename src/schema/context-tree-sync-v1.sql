-- Context Tree record recovery v1. No target resolution is stored in this journal.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_context_component') THEN
 LOCK TABLE flightdeck_pg_context_components IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_context_components ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'context_component', id::text, to_jsonb(r) FROM flightdeck_pg_context_components r WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_context_component AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_context_components FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('context_component');
 -- Existing clients must negotiate a replacement snapshot for newly registered families.
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='fd_record_context_reference') THEN
 LOCK TABLE flightdeck_pg_context_references IN SHARE ROW EXCLUSIVE MODE;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) SELECT DISTINCT workspace_id FROM flightdeck_pg_context_references ON CONFLICT DO NOTHING;
 INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row) SELECT workspace_id, 'context_reference', id::text, to_jsonb(r) FROM flightdeck_pg_context_references r WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
 CREATE TRIGGER fd_record_context_reference AFTER INSERT OR UPDATE OR DELETE ON flightdeck_pg_context_references FOR EACH ROW EXECUTE FUNCTION flightdeck_pg_record_capture('context_reference');
 -- Existing clients must negotiate a replacement snapshot for newly registered families.
 UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid();
 END IF;
END $$;
