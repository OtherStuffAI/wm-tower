import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { registerRecordClient, acknowledgeRecordCheckpoint } from '../src/services/flightdeck-record-checkpoints';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { readFileSync } from 'node:fs';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { readScopeOrder, writeScopeOrder } from '../src/services/scope-order';
import { archiveFlightDeckPgScope, archiveFlightDeckPgChannel, listVisibleFlightDeckPgEvents, listVisibleFlightDeckPgEventsForAudience, encodeFlightDeckPgEventCursor } from '../src/services/flightdeck-pg-api';
const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port===5432)('isolated personal order and lifecycle deltas',()=>{
 const name=`scope_order_archive_${process.pid}_${Date.now()}`, conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
 const secrets=[new Uint8Array(32).fill(113),new Uint8Array(32).fill(114)];
 let app:ReturnType<typeof createApp>; const requests:string[]=[];
 async function req(path:string, method='GET',actor=0,body?:any){
  requests.push(`${method} ${path}`);const data=body===undefined?undefined:JSON.stringify(body);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method',method],...(data?[['payload',createHash('sha256').update(data).digest('hex')]]:[])]},secrets[actor]!);
  const response=await app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'Content-Type':'application/json'},body:data});return {status:response.status,body:await response.json() as any};
 }
 let db:ReturnType<typeof postgres>,w:string,a:string,b:string,s:string,c:string;
 beforeAll(async()=>{
  const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${name}`);await admin.end();db=postgres({...conn,database:name});
  for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
  const actors=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${nip19.npubEncode(getPublicKey(secrets[0]!))},'human'),(${nip19.npubEncode(getPublicKey(secrets[1]!))},'human') RETURNING id`;[a,b]=actors.map(r=>r.id);
  const [ws]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service','owner','app','Isolated') RETURNING id`;w=ws!.id;
  for(const id of [a,b])await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${id},'member')`;
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Archive fixture','project') RETURNING id`;s=scope!.id;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${s},'Channel') RETURNING id`;c=channel!.id;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${w},'actor',${a},'scope',${s},'scope.read')`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${c},'channel.read')`;
  setDb(db);await ensureRuntimeSchema();app=createApp();
 });
 afterAll(async()=>{await db?.end();const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
 async function synced(actorId=a){let p=await readFlightDeckRecordPage({workspaceId:w,actorId},db);while(p.has_more)p=await readFlightDeckRecordPage({workspaceId:w,actorId,cursor:p.next_cursor},db);return p.next_cursor;}
 test('actor/workspace isolation, CAS races, retry idempotency and delta-only second-session persistence',async()=>{
  const cursor1=await synced(),cursor2=await synced(),hidden=await synced(b);
  const input={scope_ids:[s],expected_row_version:0,mutation_id:crypto.randomUUID()};
  const saved=await writeScopeOrder(w,a,input,db);expect(saved.scope_ids).toEqual([s]);
  expect((await writeScopeOrder(w,a,input,db)).row_version).toBe(1);
  expect((await readScopeOrder(w,a,db)).scope_ids).toEqual([s]);expect((await readScopeOrder(w,b,db)).scope_ids).toEqual([]);
  await expect(writeScopeOrder(w,b,{...input,mutation_id:crypto.randomUUID()},db)).rejects.toMatchObject({status:403});
  const results=await Promise.allSettled([1,2].map(()=>writeScopeOrder(w,a,{...input,expected_row_version:1,mutation_id:crypto.randomUUID()},db)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  for(const cursor of [cursor1,cursor2]){const p=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor},db);expect(p.mode).toBe('delta');expect(p.changes.every(r=>r.family==='scope_order')).toBe(true);expect(p.changes.at(-1)?.row?.scope_ids).toEqual([s]);}
  expect((await readFlightDeckRecordPage({workspaceId:w,actorId:b,cursor:hidden},db)).changes).toEqual([]);
  const events=await listVisibleFlightDeckPgEvents({workspaceId:w,actorId:b,groupIds:[],afterRowVersion:0,limit:100,includeWorkspaceEvents:true},db);expect(events.some(e=>e.entity_type==='scope_order')).toBe(false);
  const audience=await listVisibleFlightDeckPgEventsForAudience({workspaceId:w,afterRowVersion:0,limit:100,audience:[{actorId:a,npub:'viewer',groupIds:[],includeWorkspaceEvents:true}]},db);expect(audience.events.some(({event})=>event.entity_type==='scope_order')).toBe(false);
 });
 test('the same actor has independent workspace preferences and foreign targets cannot cross the partition',async()=>{
  const [other]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service-other','owner','app','Other isolated workspace') RETURNING id`;
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${other!.id},${a},'member')`;
  expect((await readScopeOrder(other!.id,a,db)).scope_ids).toEqual([]);
  await expect(writeScopeOrder(other!.id,a,{scope_ids:[s],expected_row_version:0,mutation_id:crypto.randomUUID()},db)).rejects.toMatchObject({status:400});
  const [clock]=await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${other!.id}`;
  await writeScopeOrder(other!.id,a,{scope_ids:[],expected_row_version:0,mutation_id:crypto.randomUUID()},db);
  expect((await readScopeOrder(w,a,db)).scope_ids).toEqual([s]);
  expect((await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${other!.id}`)[0]!.epoch).toBe(clock!.epoch);
 });
 test('scope archive is atomic, cursor/epoch stays valid for connected and offline clients, stored content unchanged',async()=>{
  const [message]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w},${s},${c},'Retained fixture',${a},${a}) RETURNING *`;
  const connected=await synced(),offline=await synced(),hidden=await synced(b);
  const [clock]=await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`;
  await db.begin(async tx=>{await archiveFlightDeckPgScope({workspaceId:w,scopeId:s},tx as any);});
  expect((await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`)[0]!.epoch).toBe(clock!.epoch);
  for(const cursor of [connected,offline]){const p=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor},db);expect(p.mode).toBe('delta');expect(p.changes.map(r=>[r.family,r.operation])).toEqual([['scope','delete'],['channel','delete']]);expect(p.changes.every(r=>r.row===null)).toBe(true);}
  expect((await readFlightDeckRecordPage({workspaceId:w,actorId:b,cursor:hidden},db)).changes).toEqual([]);
  expect((await db`SELECT * FROM flightdeck_pg_messages WHERE id=${message!.id}`)[0]).toEqual(message);
  expect(await archiveFlightDeckPgScope({workspaceId:w,scopeId:s},db)).toBeNull();
  await expect(writeScopeOrder(w,a,{scope_ids:[s],expected_row_version:2,mutation_id:crypto.randomUUID()},db)).rejects.toMatchObject({status:400});
 });
 test('child-only grants receive scope/channel tombstones; v2 devices resume without reset and unrelated checkpoints stay intact',async()=>{
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Child access','project') RETURNING id`;
  const [second]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Second order target','project') RETURNING id`;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'Child') RETURNING id`;
  for(const id of [scope!.id,second!.id])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${w},'actor',${a},'scope',${id},'scope.read')`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${b},'channel',${channel!.id},'channel.read')`;
  const ordered=await writeScopeOrder(w,a,{scope_ids:[second!.id,scope!.id],expected_row_version:2,mutation_id:crypto.randomUUID()},db);
  expect((await readScopeOrder(w,a,db)).scope_ids).toEqual([second!.id,scope!.id]);expect(ordered.row_version).toBe(3);
  const devices=await Promise.all([0,1,2].map(async()=>{
   const clientId=crypto.randomUUID();const input={workspaceId:w,actorId:b,clientId};const registered=await registerRecordClient(input,db);
   let p=await readFlightDeckRecordPage({...input,protocolVersion:2,cursor:registered.initial_cursor},db);while(p.has_more)p=await readFlightDeckRecordPage({...input,protocolVersion:2,cursor:p.next_cursor},db);
   const saved=await acknowledgeRecordCheckpoint({...input,cursor:p.next_cursor,expectedRevision:p.checkpoint_revision},db);return {...input,cursor:saved.checkpoint_cursor!};
  }));
  const before=await db`SELECT * FROM flightdeck_pg_record_clients WHERE workspace_id=${w} ORDER BY client_id`;
  await db.begin(async tx=>{await archiveFlightDeckPgScope({workspaceId:w,scopeId:scope!.id},tx as any);});
  for(const device of devices){const p=await readFlightDeckRecordPage({...device,protocolVersion:2},db);expect(p.mode).toBe('delta');expect(p.changes.map(r=>[r.family,r.operation])).toEqual([['scope','delete'],['channel','delete']]);}
  const after=await db`SELECT * FROM flightdeck_pg_record_clients WHERE workspace_id=${w} ORDER BY client_id`;expect(after.map(r=>r.checkpoint_cursor)).toEqual(before.map(r=>r.checkpoint_cursor));
  const cursor=await synced(b);await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${w} AND principal_actor_id=${b}`;
  const revoked=await readFlightDeckRecordPage({workspaceId:w,actorId:b,cursor},db);
  expect(revoked.mode).toBe('delta');
  expect(revoked.changes).toEqual([]); // Revocation preserves the cursor and never returns forbidden content.
 });
 test('signed routes: two sessions plus offline reconnect use only scoped delta requests and private preference',async()=>{
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Route fixture','project') RETURNING id`;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'Route channel') RETURNING id`;
  for(const permission of ['scope.read','scope.manage'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${w},'actor',${a},'scope',${scope!.id},${permission})`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${channel!.id},'channel.read')`;
  const base=`/api/v4/flightdeck-pg/workspaces/${w}`;
  const cursors=await Promise.all([synced(),synced(),synced()]); requests.length=0;
  const [high]=await db`SELECT coalesce(max(row_version),0)::int n FROM flightdeck_pg_outbox_events WHERE workspace_id=${w}`;
  const streamPath=`${base}/events/stream?cursor=${encodeURIComponent(encodeFlightDeckPgEventCursor(high!.n))}`;
  const streams=await Promise.all([0,1].map(async()=>{
   requests.push(`GET ${streamPath}`);const abort=new AbortController();
   const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${streamPath}`],['method','GET']]},secrets[0]!);
   const response=await app.request(streamPath,{signal:abort.signal,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`}});
   expect(response.status).toBe(200);const reader=response.body!.getReader();await reader.read();return {reader,abort};
  }));
  const pref={scope_ids:[scope!.id],expected_row_version:3,mutation_id:crypto.randomUUID()};
  expect((await req(`${base}/me/scope-order`,'PUT',0,pref)).status).toBe(200);
  expect((await req(`${base}/me/scope-order`)).body.scope_order.scope_ids).toEqual([scope!.id]);
  expect((await req(`${base}/me/scope-order`,'GET',1)).body.scope_order.scope_ids).toEqual([]);
  expect((await req(`${base}/scopes/${scope!.id}`,'DELETE',1)).status).toBe(403);
  const deleted=await req(`${base}/scopes/${scope!.id}`,'DELETE');expect(deleted.status).toBe(200);
  for(const {reader,abort} of streams){
   try { let trace='';const deadline=Date.now()+5000;while(!trace.includes('scope.archived')&&Date.now()<deadline){const next=await reader.read();trace+=new TextDecoder().decode(next.value);}expect(trace).toContain('scope.archived');expect(trace).toContain('scope_order.updated'); }
   finally {abort.abort();await reader.cancel();}
  }
  expect((await req(`${base}/scopes/${scope!.id}`,'DELETE')).status).toBe(200);
  for(const cursor of cursors){const res=await req(`${base}/record-sync?protocol_version=1&cursor=${encodeURIComponent(cursor)}`);expect(res.status).toBe(200);expect(res.body.mode).toBe('delta');expect(res.body.changes.map((r:any)=>r.family).sort()).toEqual(['channel','scope','scope_order']);}
  expect(requests.filter(r=>r.includes('/record-sync')).every(r=>r.includes('cursor='))).toBe(true);
  expect(requests.some(r=>/bootstrap|messages|tasks|docs|files/.test(r))).toBe(false);
  expect((await db`SELECT count(*)::int n FROM flightdeck_pg_audit_events WHERE resource_id=${scope!.id} AND action='scope.delete'`)[0]!.n).toBe(1);
 });
 test('simultaneous signed reorder and archive serialize without deadlock or server errors',async()=>{
  const base=`/api/v4/flightdeck-pg/workspaces/${w}`;
  for(let round=0;round<4;round++){
   const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},${`Race ${round}`},'project') RETURNING id`;
   for(const permission of ['scope.read','scope.manage'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${w},'actor',${a},'scope',${scope!.id},${permission})`;
   const version=(await readScopeOrder(w,a,db)).row_version;
   const [order,archive]=await Promise.all([req(`${base}/me/scope-order`,'PUT',0,{scope_ids:[scope!.id],expected_row_version:version,mutation_id:crypto.randomUUID()}),req(`${base}/scopes/${scope!.id}`,'DELETE')]);
   expect([200,400]).toContain(order.status);expect(archive.status).toBe(200);
   expect((await db`SELECT archived_at FROM flightdeck_pg_scopes WHERE id=${scope!.id}`)[0]!.archived_at).not.toBeNull();
  }
 });
 test('channel-only archive leaves its scope and sibling content untouched and rolls back tombstones atomically',async()=>{
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Channel-only','project') RETURNING *`;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'Only channel') RETURNING *`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${channel!.id},'channel.read')`;
  const cursor=await synced();
  await expect(db.begin(async tx=>{await archiveFlightDeckPgChannel({workspaceId:w,channelId:channel!.id},tx as any);throw Error('fixture rollback');})).rejects.toThrow('fixture rollback');
  expect((await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor},db)).changes).toEqual([]);
  await db.begin(async tx=>{await archiveFlightDeckPgChannel({workspaceId:w,channelId:channel!.id},tx as any);});
  const p=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor},db);expect(p.mode).toBe('delta');expect(p.changes.map(r=>[r.family,r.operation])).toEqual([['channel','delete']]);
  expect((await db`SELECT * FROM flightdeck_pg_scopes WHERE id=${scope!.id}`)[0]).toEqual(scope);
 });
 test('protected system channels and DM scopes cannot be archived',async()=>{
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'DM fixture','dm') RETURNING id`;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind) VALUES(${w},${scope!.id},'System','system') RETURNING id`;
  expect(await archiveFlightDeckPgScope({workspaceId:w,scopeId:scope!.id},db)).toBeNull();expect(await archiveFlightDeckPgChannel({workspaceId:w,channelId:channel!.id},db)).toBeNull();
 });
 test('signed DM archive requires manage, retains content, publishes tombstones and retries without duplicate events',async()=>{
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Removal DMs','dm') RETURNING *`;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind) VALUES(${w},${scope!.id},'Disposable DM','dm') RETURNING *`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${w},'actor',${a},'scope',${scope!.id},'scope.read')`;
  for(const permission of ['channel.read','channel.manage'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${channel!.id},${permission})`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${b},'channel',${channel!.id},'channel.read')`;
  const [message]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${w},${scope!.id},${channel!.id},'Retained DM content',${a},${a}) RETURNING *`;
  const cursors=await Promise.all([synced(a),synced(b)]);
  const path=`/api/v4/flightdeck-pg/workspaces/${w}/channels/${channel!.id}`;
  expect((await req(path,'DELETE',1)).status).toBe(403);
  expect((await db`SELECT archived_at FROM flightdeck_pg_channels WHERE id=${channel!.id}`)[0]!.archived_at).toBeNull();
  const wrong=await req(`/api/v4/flightdeck-pg/workspaces/${crypto.randomUUID()}/channels/${channel!.id}`,'DELETE');
  expect([403,404]).toContain(wrong.status);
  const removed=await req(path,'DELETE');expect(removed.status).toBe(200);expect((await db`SELECT archived_at FROM flightdeck_pg_channels WHERE id=${channel!.id}`)[0]!.archived_at).toBeTruthy();
  expect((await req(path,'DELETE')).status).toBe(200);
  const active=await req(`/api/v4/flightdeck-pg/workspaces/${w}/scopes/${scope!.id}/channels`);
  expect(active.status).toBe(200);expect(active.body.channels.some((row:any)=>row.id===channel!.id)).toBe(false);
  expect([403,404]).toContain((await req(path)).status);
  for(const [index,actorId] of [a,b].entries()){
   const page=await readFlightDeckRecordPage({workspaceId:w,actorId,cursor:cursors[index]},db);
   expect(page.mode).toBe('delta');expect(page.changes.map(r=>[r.family,r.operation,r.id])).toEqual([['channel','delete',channel!.id]]);
  }
  expect((await db`SELECT * FROM flightdeck_pg_messages WHERE id=${message!.id}`)[0]).toEqual(message);
  expect((await db`SELECT * FROM flightdeck_pg_scopes WHERE id=${scope!.id}`)[0]).toEqual(scope);
  expect((await db`SELECT count(*)::int n FROM flightdeck_pg_audit_events WHERE resource_id=${channel!.id} AND action='channel.delete'`)[0]!.n).toBe(1);
  expect((await db`SELECT count(*)::int n FROM flightdeck_pg_outbox_events WHERE entity_id=${channel!.id} AND event_type='channel.archived'`)[0]!.n).toBe(1);
 });
 test('signed managed system and system-key DM removal stays refused without lifecycle events',async()=>{
  const [protectedScope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Protected removal','project') RETURNING id`;
  for(const kind of ['system','dm']){
   const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,metadata) VALUES(${w},${protectedScope!.id},${'Protected '+kind},${kind},${db.json(kind==='dm'?{system_key:'protected'}:{})}) RETURNING id`;
   await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${channel!.id},'channel.manage')`;
   expect((await req(`/api/v4/flightdeck-pg/workspaces/${w}/channels/${channel!.id}`,'DELETE')).status).toBe(404);
   expect((await db`SELECT archived_at FROM flightdeck_pg_channels WHERE id=${channel!.id}`)[0]!.archived_at).toBeNull();
   expect((await db`SELECT count(*)::int n FROM flightdeck_pg_outbox_events WHERE entity_id=${channel!.id} AND event_type='channel.archived'`)[0]!.n).toBe(0);
  }
 });

});
