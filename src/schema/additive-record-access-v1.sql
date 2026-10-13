-- Authority observation is independent of the ordinary journal and epoch.
ALTER TABLE flightdeck_pg_record_clock ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE flightdeck_pg_record_current ADD COLUMN IF NOT EXISTS position BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_fd_record_current_channel_partition ON flightdeck_pg_record_current
  (workspace_id,family,(COALESCE(context->>'channel_id',CASE WHEN family='channel' THEN id END)),id) INCLUDE(position);
CREATE INDEX IF NOT EXISTS idx_fd_record_current_scope_partition ON flightdeck_pg_record_current
  (workspace_id,family,(COALESCE(context->>'scope_id',CASE WHEN family='scope' THEN id END)),id) INCLUDE(position);


-- Effective read partitions mirror record delivery. These are catchup candidates,
-- never authorization proofs: the delivery path still checks every entry.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_access(w UUID, a UUID) RETURNS JSONB
LANGUAGE sql STABLE AS $$
 WITH RECURSIVE groups(id) AS (
   SELECT group_id FROM flightdeck_pg_group_memberships WHERE workspace_id=w AND actor_id=a
   UNION SELECT e.parent_group_id FROM flightdeck_pg_group_edges e JOIN groups g ON g.id=e.child_group_id WHERE e.workspace_id=w
 ), grants AS (
   SELECT g.* FROM flightdeck_pg_permission_grants g
   WHERE g.workspace_id=w AND g.revoked_at IS NULL
   AND EXISTS(SELECT 1 FROM flightdeck_pg_workspace_memberships WHERE workspace_id=w AND actor_id=a)
   AND ((g.principal_type='actor' AND g.principal_actor_id=a) OR (g.principal_type='group' AND g.principal_group_id IN(SELECT id FROM groups)))
 ), channels AS (
   SELECT DISTINCT c.id,c.scope_id,g.permission FROM grants g
   JOIN flightdeck_pg_channels c ON c.workspace_id=w AND c.id=g.resource_channel_id AND c.archived_at IS NULL
   JOIN flightdeck_pg_scopes s ON s.workspace_id=w AND s.id=c.scope_id AND s.archived_at IS NULL
   WHERE g.resource_type='channel'
 ), scopes AS (
   SELECT s.id FROM grants g JOIN flightdeck_pg_scopes s ON s.workspace_id=w AND s.id=g.resource_scope_id AND s.archived_at IS NULL
   WHERE g.resource_type='scope' AND g.permission IN('scope.read','scope.manage','context.edit')
   UNION SELECT scope_id FROM channels WHERE permission='channel.read'
 ), keys AS (
   SELECT 'channel:'||id::text||':'||f AS key FROM channels
   CROSS JOIN LATERAL unnest(CASE permission
     WHEN 'channel.read' THEN ARRAY['channel','thread','message','doc','doc_comment','file','file_folder','audio_note','resource_view_state/thread','resource_view_state/document']
     WHEN 'task.read' THEN ARRAY['task','task_comment','task_assignment','resource_view_state/task']
     WHEN 'doc.read' THEN ARRAY['doc','doc_comment','resource_view_state/document']
     WHEN 'file.read' THEN ARRAY['file']
     WHEN 'audio_note.read' THEN ARRAY['audio_note'] ELSE ARRAY[]::text[] END) f
   UNION SELECT 'scope:'||id::text||':'||f FROM scopes CROSS JOIN unnest(ARRAY['scope','context_component','context_reference']) f
   UNION SELECT 'workspace:'||w::text||':'||f FROM grants CROSS JOIN unnest(ARRAY['autopilot_connection','workspace_agent']) f
     WHERE resource_type='workspace' AND permission='workspace.read'
 ) SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) FROM keys
$$;

-- Existing record writers now retain the canonical row's journal position.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_emit(w UUID, f TEXT, r JSONB, op TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ DECLARE p BIGINT; ident TEXT; BEGIN
 IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN; END IF;
 INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 UPDATE flightdeck_pg_record_clock SET position=position+1 WHERE workspace_id=w RETURNING position INTO p;
 ident:=flightdeck_pg_record_identity(f,r);
 INSERT INTO flightdeck_pg_record_journal(workspace_id,position,family,id,operation,row) VALUES(w,p,f,ident,op,r);
 IF op='delete' THEN DELETE FROM flightdeck_pg_record_current WHERE workspace_id=w AND family=f AND id=ident;
 ELSE INSERT INTO flightdeck_pg_record_current(workspace_id,family,id,row,position) VALUES(w,f,ident,r,p)
 ON CONFLICT(workspace_id,family,id) DO UPDATE SET row=EXCLUDED.row,position=EXCLUDED.position; END IF;
END $$;

CREATE OR REPLACE FUNCTION flightdeck_pg_record_capture() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; oldr JSONB; w UUID; child RECORD; table_name TEXT; kind TEXT; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 w := (r->>'workspace_id')::uuid;
 IF TG_OP='UPDATE' THEN
 oldr:=to_jsonb(OLD);
 IF (oldr->>'channel_id') IS DISTINCT FROM (r->>'channel_id') OR (oldr->>'owner_actor_id') IS DISTINCT FROM (r->>'owner_actor_id') OR flightdeck_pg_record_identity(TG_ARGV[0],oldr) IS DISTINCT FROM flightdeck_pg_record_identity(TG_ARGV[0],r) THEN
 PERFORM flightdeck_pg_record_emit((oldr->>'workspace_id')::uuid,TG_ARGV[0],oldr,'delete');
 END IF; END IF;
 PERFORM flightdeck_pg_record_emit(w,TG_ARGV[0],r,CASE WHEN TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL OR r->>'archived_at' IS NOT NULL THEN 'delete' ELSE 'upsert' END);
 IF TG_ARGV[0] IN ('task','doc','thread') AND (TG_OP='DELETE' OR r->>'deleted_at' IS NOT NULL) THEN
 -- Real content deletion emits explicit dependent tombstones. Permission
 -- filtering never invokes this path and never manufactures deletion records.
 FOR child IN SELECT family,row FROM flightdeck_pg_record_current c WHERE c.workspace_id=w AND (
   (TG_ARGV[0]='task' AND c.family IN('task_comment','task_assignment') AND c.context->>'task_id'=r->>'id') OR
   (TG_ARGV[0]='doc' AND c.family='doc_comment' AND c.context->>'doc_id'=r->>'id') OR
   (TG_ARGV[0]='thread' AND c.family='message' AND c.context->>'thread_id'=r->>'id') OR
   (c.family='resource_view_state' AND c.context->>'resource_id'=r->>'id'
     AND c.context->>'resource_type'=CASE TG_ARGV[0] WHEN 'doc' THEN 'document' ELSE TG_ARGV[0] END))
 ORDER BY family,id LOOP
   PERFORM flightdeck_pg_record_emit(w,child.family,child.row,'delete');
 END LOOP;
 END IF;
 -- A genuine parent restoration must also restore its surviving dependents.
 IF TG_OP='UPDATE' AND TG_ARGV[0] IN('task','doc','thread') AND oldr->>'deleted_at' IS NOT NULL AND r->>'deleted_at' IS NULL THEN
   FOR kind,table_name IN SELECT * FROM (VALUES
     ('task_comment','flightdeck_pg_task_comments'),('task_assignment','flightdeck_pg_task_assignments'),
     ('doc_comment','flightdeck_pg_doc_comments'),('message','flightdeck_pg_messages'),
     ('resource_view_state','flightdeck_pg_resource_view_states')) AS families(f,t)
   WHERE (TG_ARGV[0]='task' AND f IN('task_comment','task_assignment')) OR (TG_ARGV[0]='doc' AND f='doc_comment')
     OR (TG_ARGV[0]='thread' AND f='message') OR f='resource_view_state'
   LOOP
     IF kind='resource_view_state' THEN
       FOR child IN EXECUTE format('SELECT to_jsonb(t) AS row FROM %I t WHERE workspace_id=$1 AND resource_id=$2::uuid AND resource_type=$3',table_name)
         USING w,r->>'id',CASE TG_ARGV[0] WHEN 'doc' THEN 'document' ELSE TG_ARGV[0] END LOOP
         PERFORM flightdeck_pg_record_emit(w,kind,child.row,'upsert');
       END LOOP;
     ELSE
       FOR child IN EXECUTE format('SELECT to_jsonb(t) AS row FROM %I t WHERE workspace_id=$1 AND %I=$2::uuid AND to_jsonb(t)->>''deleted_at'' IS NULL',
         table_name,CASE TG_ARGV[0] WHEN 'task' THEN 'task_id' WHEN 'doc' THEN 'doc_id' ELSE 'thread_id' END) USING w,r->>'id' LOOP
         PERFORM flightdeck_pg_record_emit(w,kind,child.row,'upsert');
       END LOOP;
     END IF;
   END LOOP;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- Replaces the installed function used by ALL authority triggers, including grants.
-- Clock updates force stale repeatable-read delivery to retry; no authority reset.
CREATE OR REPLACE FUNCTION flightdeck_pg_record_reset() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ DECLARE r JSONB; w UUID; BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN RETURN NEW; END IF;
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='flightdeck_pg_actors' THEN
   IF TG_OP='UPDATE' AND OLD.npub=NEW.npub AND OLD.kind=NEW.kind THEN RETURN NEW; END IF;
   -- Identity rebinding is a genuine boundary, never a permission transition.
   UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid(),access_revision=access_revision+1 WHERE workspace_id IN
     (SELECT workspace_id FROM flightdeck_pg_workspace_memberships WHERE actor_id=(r->>'id')::uuid);
 ELSE
   w:=COALESCE(r->>'workspace_id',r->>'id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM flightdeck_pg_workspaces WHERE id=w) THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
   INSERT INTO flightdeck_pg_record_clock(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
   IF TG_TABLE_NAME='flightdeck_pg_workspaces' AND TG_OP='UPDATE' AND
     (to_jsonb(OLD)->'workspace_owner_npub',to_jsonb(OLD)->'app_npub',to_jsonb(OLD)->'workspace_service_npub',to_jsonb(OLD)->'tower_service_npub')
       IS DISTINCT FROM (r->'workspace_owner_npub',r->'app_npub',r->'workspace_service_npub',r->'tower_service_npub') THEN
     UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid(),access_revision=access_revision+1 WHERE workspace_id=w;
   ELSE UPDATE flightdeck_pg_record_clock SET access_revision=access_revision+1 WHERE workspace_id=w; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

-- Seed pre-extension continuations exactly once. Lock authority AND clock tables
-- before baselining, so a concurrent grant cannot fall between old/new contracts.
DO $$ BEGIN
 LOCK TABLE flightdeck_pg_permission_grants,flightdeck_pg_group_memberships,flightdeck_pg_group_edges,
   flightdeck_pg_workspace_memberships,flightdeck_pg_actors,flightdeck_pg_scopes,flightdeck_pg_channels,
   flightdeck_pg_workspaces IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE flightdeck_pg_record_clock IN SHARE ROW EXCLUSIVE MODE;
 -- Aggregate once rather than rescanning the journal for every zero-position
 -- row. Missing/pruned history stays at zero without rewriting those rows on
 -- every startup; existing nonzero positions remain authoritative.
 UPDATE flightdeck_pg_record_current c SET position=j.position
 FROM (
   SELECT workspace_id,family,id,max(position) AS position
   FROM flightdeck_pg_record_journal GROUP BY workspace_id,family,id
 ) j
 WHERE c.position=0 AND c.workspace_id=j.workspace_id
   AND c.family=j.family AND c.id=j.id AND j.position<>0;
 UPDATE flightdeck_pg_record_cursors c SET state=state||jsonb_build_object(
   'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0')
 FROM flightdeck_pg_record_clock k WHERE k.workspace_id=c.workspace_id AND NOT c.state ? 'access';
 IF to_regclass('flightdeck_pg_record_clients') IS NOT NULL THEN
 UPDATE flightdeck_pg_record_clients c SET initial_state=initial_state||jsonb_build_object(
   'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0'),
   checkpoint_state=CASE WHEN checkpoint_state IS NULL THEN NULL ELSE checkpoint_state||jsonb_build_object(
     'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0') END
 FROM flightdeck_pg_record_clock k WHERE k.workspace_id=c.workspace_id AND NOT c.initial_state ? 'access';
 END IF;
 IF to_regclass('flightdeck_pg_record_page_tokens') IS NOT NULL THEN
 UPDATE flightdeck_pg_record_page_tokens c SET state=state||jsonb_build_object(
   'access',flightdeck_pg_record_access(c.workspace_id,c.actor_id),'accessRevision',k.access_revision::text,'progress','0')
 FROM flightdeck_pg_record_clock k WHERE k.workspace_id=c.workspace_id AND NOT c.state ? 'access';
 END IF;
END $$;
