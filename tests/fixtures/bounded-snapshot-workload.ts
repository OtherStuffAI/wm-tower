import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nip19 } from 'nostr-tools';
import type postgres from 'postgres';
import { recordFamilies } from '../../src/services/flightdeck-record-families';
/** Shared isolated workload: real domain rows, FKs and mutation triggers. Caller
 * separately inserts 100k messages and 2095 2KB comments. Hidden scopes/channels
 * and other actors' scope orders prove empty-progress pages without huge ACLs. */
export async function seedBoundedRecordWorkload(sql:ReturnType<typeof postgres>,c:{workspaceId:string;actorId:string;scopeId:string;channelId:string;taskId?:string},count=10001) {
  if(!Number.isSafeInteger(count)||count<1)throw new Error('invalid fixture cardinality');
  const canonical=JSON.parse(readFileSync(new URL('./flightdeck-record-delta-v1.json',import.meta.url),'utf8')).canonical_upserts.changes;
  const agentNpub=nip19.npubEncode(createHash('sha256').update('bounded fixture agent public identity').digest('hex'));
  const context=JSON.parse(readFileSync(new URL('./context-record-delta-v1.json',import.meta.url),'utf8'));
  for(let start=1;start<count;start+=1000){
    const actors=Array.from({length:Math.min(1000,count-start)},(_,offset)=>{
      const i=start+offset,hex=createHash('md5').update('actor'+i).digest('hex');
      return{id:`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,npub:nip19.npubEncode(createHash('sha256').update('bounded fixture public identity '+i).digest('hex')),kind:'human',display_name:'Fixture '+i};
    });
    await sql`INSERT INTO flightdeck_pg_actors ${sql(actors,'id','npub','kind','display_name')} ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) SELECT ${c.workspaceId},id,'member' FROM flightdeck_pg_actors WHERE id IN ${sql(actors.map(a=>a.id))} ON CONFLICT DO NOTHING`;
  }
  for(const [family,suffix] of Object.entries(recordFamilies)){
    if(family==='message')continue;
    const template=family==='personal_pin'?{id:c.actorId,workspace_id:c.workspaceId,actor_id:c.actorId,resource_type:'thread',resource_id:c.actorId,thread_id:c.actorId,pinned:true,pinned_at:'2026-01-01T00:00:00Z',row_version:1,updated_at:'2026-01-01T00:00:00Z'}
      :family==='scope_order'?{workspace_id:c.workspaceId,actor_id:c.actorId,scope_ids:[c.scopeId],row_version:1,updated_at:'2026-01-01T00:00:00Z'}
      :family==='context_component'?context.components[0]:family==='context_reference'?context.references[0]:canonical.find((r:any)=>r.family===family).row;
    const table=`flightdeck_pg_${suffix}`;
    if(['doc','file','audio_note'].includes(family))for(let start=0;start<count;start+=1000)await sql`INSERT INTO v4_storage_objects(id,owner_npub,created_by_npub,file_name,content_type,storage_path)
      SELECT md5('storage-'||${family}||i::text)::uuid,'owner','creator',${family}||i::text,${family==='audio_note'?'audio/ogg':family==='doc'?'text/plain':'application/octet-stream'},'bounded-fixture/'||${family}||i::text
      FROM generate_series(${start}::int,${Math.min(start+999,count-1)}::int) i ON CONFLICT DO NOTHING`;
    for(let start=0;start<count;start+=1000){
      // Unknown overlay fields are ignored by jsonb_populate_record; resulting
      // canonical rows contain exactly the table's own columns, including
      // composite identities for scope orders, assignments and view states.
      await sql`INSERT INTO ${sql(table)} SELECT (jsonb_populate_record(NULL::${sql(table)},${sql.json(template)}::jsonb ||
        jsonb_build_object('id',md5(${family}||i::text)::uuid,'workspace_id',${c.workspaceId}::uuid,'scope_id',${c.scopeId}::uuid,'channel_id',${c.channelId}::uuid,
          'created_by_actor_id',${c.actorId}::uuid,'updated_by_actor_id',${c.actorId}::uuid,'owner_actor_id',${c.actorId}::uuid,
          'actor_id',CASE WHEN ${family}='scope_order' AND i>0 THEN md5('actor'||i::text)::uuid ELSE ${c.actorId}::uuid END,
          'viewer_actor_id',${c.actorId}::uuid,'reader_actor_id',${c.actorId}::uuid,'storage_object_id',md5('storage-'||${family}||i::text)::uuid,
          'task_id',md5('task'||i::text)::uuid,'doc_id',md5('doc'||i::text)::uuid,'resource_type','task','resource_id',md5('task'||i::text)::uuid,
          'connection_id',md5('autopilot_connection'||i::text)::uuid,'installation_id',md5('installation'||i::text),
          'name','Fixture '||i::text,'title','Fixture '||i::text,'agent_id','fixture-agent-'||i::text,'agent_npub',${agentNpub}::text,
          'note_date',DATE '1900-01-01'+i,'subscription_id',md5('feed_subscription'||i::text)::uuid,'item_id','fixture-item-'||i::text,
          'source',jsonb_build_object('kind','public','url','https://example.test/fixture/'||i::text,'format','rss'),
          'source_key',jsonb_build_array('public','https://example.test/fixture/'||i::text),
          'component_id',md5('context_component'||i::text)::uuid,'target_type','task','target_id',md5('task'||i::text)::uuid,
          'target',jsonb_build_object('record_id',md5('task'||i::text)::uuid)) ||
        jsonb_build_object('deleted_by_actor_id',NULL,'archived_by_actor_id',NULL,'thread_id',CASE WHEN ${family}='thread_pin' THEN md5('thread'||i::text)::uuid ELSE NULL END,'parent_thread_id',NULL,'source_message_id',NULL,'branch_point_message_id',NULL,
          'parent_id',NULL,'parent_folder_id',NULL,'folder_id',NULL,'parent_comment_id',NULL,'current_version_id',NULL,'owner_group_id',NULL,
          'default_channel_id',NULL,'wapp_installation_id',NULL,'client_request_id',NULL,'client_request_hash',NULL,'viewed_activity_version',0))).*
        FROM generate_series(${start}::int,${Math.min(start+999,count-1)}::int) i ON CONFLICT DO NOTHING`;
    }
  }
}
