import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import postgres from 'postgres';
import {readFileSync} from 'node:fs';
import {splitSqlStatements} from '../src/schema/sql-statements';
import {readFlightDeckRecordPage} from '../src/services/flightdeck-record-delta';
import {normalizePriorityFilters,readContextClosure,readPriorityRecords,readRepairManifest,repairRecords} from '../src/services/flightdeck-record-priority';
import {readPriorityLargeRecordChunk} from '../src/services/flightdeck-record-large';
import {createApp} from '../src/server';

const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port||port===5432)('priority record sync and compact repair',()=>{
  const database=`tower_record_priority_${process.pid}_${Date.now()}`;
  const connection={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  let db:ReturnType<typeof postgres>;let workspaceId:string,actorId:string,otherActorId:string,scopeId:string,channelId:string,hiddenChannelId:string;
  const appNpub='priority-app';
  beforeAll(async()=>{const admin=postgres({...connection,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${database}`);await admin.end();
    db=postgres({...connection,database});for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
    const [actor]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('npub1priority','human') RETURNING id`;actorId=actor!.id;
    const [other]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('npub1priorityother','human') RETURNING id`;otherActorId=other!.id;
    const [workspace]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('tower','workspace','owner',${appNpub},'Priority',${actorId}) RETURNING id`;workspaceId=workspace!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${actorId},'owner'),(${workspaceId},${otherActorId},'member')`;
    const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Scope','project') RETURNING id`;scopeId=scope!.id;
    const channels=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Visible'),(${workspaceId},${scopeId},'Hidden') RETURNING id,name`;
    channelId=channels.find(row=>row.name==='Visible')!.id;hiddenChannelId=channels.find(row=>row.name==='Hidden')!.id;
    for(const permission of ['channel.read','task.read','doc.read'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},${permission})`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission)
      VALUES(${workspaceId},'actor',${actorId},'scope',${scopeId},'scope.read')`;
  });
  afterAll(async()=>{await db?.end();const admin=postgres({...connection,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);await admin.end();});
  const viewer=()=>({workspaceId,actorId,appNpub});
  async function message(body:string,channel=channelId){const [row]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channel},${body},${actorId},${actorId}) RETURNING *`;return row!;}

  test('priority is newest-first, bounded, filtered and continuation-bound',async()=>{const first=await message('first');const second=await message('second');await message('hidden',hiddenChannelId);
    const filters=normalizePriorityFilters({families:['message'],channelId});const page1=await readPriorityRecords({...viewer(),filters,limit:1},db);
    expect(page1.changes.map(change=>change.id)).toEqual([second.id]);expect(page1.has_more).toBe(true);expect(page1.coverage).toBe('partial');
    const page2=await readPriorityRecords({...viewer(),filters,cursor:page1.next_cursor,limit:1},db);expect(page2.changes.map(change=>change.id)).toEqual([first.id]);
    await expect(readPriorityRecords({...viewer(),filters:normalizePriorityFilters({families:['task']}),cursor:page1.next_cursor},db)).rejects.toMatchObject({code:'auxiliary_cursor_invalid'});
    await expect(readPriorityRecords({...viewer(),appNpub:'wrong',filters,cursor:page1.next_cursor},db)).rejects.toMatchObject({status:403});
    const hidden=await readPriorityRecords({...viewer(),actorId:otherActorId,filters:normalizePriorityFilters({families:['message']})},db);expect(hidden.changes).toEqual([]);
  });

  test('context returns only the authorized parent-first canonical closure',async()=>{const [thread]=await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},'Thread',${actorId},${actorId}) RETURNING id`;
    const closure=await readContextClosure({...viewer(),resourceType:'thread',resourceId:thread!.id},db);expect(closure.changes.map(change=>change.family)).toEqual(['scope','channel','thread']);
    const [secret]=await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspaceId},${scopeId},${hiddenChannelId},'Secret',${actorId},${actorId}) RETURNING id`;
    const denied=await readContextClosure({...viewer(),resourceType:'thread',resourceId:secret!.id},db);expect(denied.changes).toEqual([]);expect(denied.dependencies).toEqual([]);
  });

  test('stable manifest carries tombstones and selective repair returns current bodies',async()=>{const deleted=await message('delete me');await db`DELETE FROM flightdeck_pg_messages WHERE id=${deleted.id}`;
    const filters=normalizePriorityFilters({families:['message'],channelId});let cursor:undefined|string;const entries:any[]=[];let captured:string|undefined;
    do{const page=await readRepairManifest({...viewer(),filters,cursor,limit:1},db);captured??=page.captured_head;expect(page.captured_head).toBe(captured);entries.push(...page.entries);cursor=page.has_more?page.next_cursor:undefined;if(!page.has_more)break;}while(true);
    const tombstone=entries.find(entry=>entry.id===deleted.id);expect(tombstone).toMatchObject({state:'deleted'});
    const repaired=await repairRecords({...viewer(),records:[{family:'message',id:deleted.id,version:tombstone.version}]},db);expect(repaired.changes[0]).toMatchObject({id:deleted.id,operation:'delete',row:null});
    const hidden=await repairRecords({...viewer(),records:[{family:'message',id:(await message('secret repair',hiddenChannelId)).id}]},db);expect(hidden.changes).toEqual([]);expect(hidden.unresolved[0]!.reason).toBe('not_available');
  });

  test('a newer priority row cannot be regressed by an older completeness page',async()=>{let snapshot=await readFlightDeckRecordPage({workspaceId,actorId,limit:200},db);while(snapshot.has_more)snapshot=await readFlightDeckRecordPage({workspaceId,actorId,cursor:snapshot.next_cursor,limit:200},db);
    const row=await message('old');const oldPage=await readFlightDeckRecordPage({workspaceId,actorId,cursor:snapshot.next_cursor},db);await db`UPDATE flightdeck_pg_messages SET body='new' WHERE id=${row.id}`;
    const priority=await readPriorityRecords({...viewer(),filters:normalizePriorityFilters({families:['message'],channelId})},db);const newest=priority.changes.find(change=>change.id===row.id)!;const older=oldPage.changes.find(change=>change.id===row.id)!;
    expect(BigInt(newest.version)).toBeGreaterThan(BigInt(older.version));const applied=[newest,older].reduce((current,next)=>!current||BigInt(next.version)>BigInt(current.version)?next:current,undefined as typeof newest|undefined);expect(applied!.row?.body).toBe('new');
  });

  test('schema exposes bounded index plans instead of workspace-wide reverse sorting',async()=>{const plans=await db`EXPLAIN (FORMAT JSON) SELECT family,id,position FROM flightdeck_pg_record_heads WHERE workspace_id=${workspaceId} AND position<=999999 ORDER BY position DESC,family DESC,id DESC LIMIT 201`;
    expect(JSON.stringify(plans)).toContain('idx_fd_record_heads_priority');const indexes=await db`SELECT indexname FROM pg_indexes WHERE tablename IN ('flightdeck_pg_record_heads','flightdeck_pg_record_journal')`;
    expect(indexes.map(row=>row.indexname)).toContain('idx_fd_record_journal_manifest');
  });

  test('priority can return and revalidate the existing chunk manifest shape for one oversized row',async()=>{const huge=await message('x'.repeat(1_300_000));const filters=normalizePriorityFilters({families:['message'],channelId});
    let oversized:any;try{await readPriorityRecords({...viewer(),filters,limit:1},db);}catch(error){oversized=error;}expect(oversized).toMatchObject({code:'record_too_large'});
    const page=await readPriorityRecords({...viewer(),filters,limit:1,largeRecords:'chunked_v1'},db);const manifest=page.large_records![0]!;expect(manifest.id).toBe(huge.id);expect(page.changes).toEqual([]);
    const parts:Uint8Array[]=[];for(let index=0;index<manifest.chunk_count;index++)parts.push(await readPriorityLargeRecordChunk({...viewer(),cursor:page.next_cursor,manifestId:manifest.manifest_id,index},db));
    const envelope=JSON.parse(Buffer.concat(parts).toString('utf8'));expect(envelope.change.row.body.length).toBe(1_300_000);expect(envelope.change.version).toBe(manifest.version);
  });
});

test('priority and repair HTTP surfaces require NIP-98 before resolving workspace state',async()=>{const app=createApp();const base='/api/v4/flightdeck-pg/workspaces/00000000-0000-4000-8000-000000000001/record-sync';
  for(const request of [new Request(`http://localhost${base}/priority`),new Request(`http://localhost${base}/context?resource_type=task&resource_id=00000000-0000-4000-8000-000000000002`),new Request(`http://localhost${base}/repair-manifest`),new Request(`http://localhost${base}/repair`,{method:'POST',headers:{'content-type':'application/json'},body:'{"records":[]}'})]){
    expect((await app.request(request)).status).toBe(401);
  }
});
