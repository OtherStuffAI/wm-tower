import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { readFileSync } from 'node:fs';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { mutateThreadPin } from '../src/services/thread-pins';
import { listVisibleFlightDeckPgEvents, listVisibleFlightDeckPgEventsForAudience } from '../src/services/flightdeck-pg-api';
const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port===5432)('personal pin contract against isolated Postgres',()=>{
 const name=`thread_pins_${process.pid}_${Date.now()}`, conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
 const secrets=[new Uint8Array(32).fill(119),new Uint8Array(32).fill(120)];
 let db:ReturnType<typeof postgres>,app:ReturnType<typeof createApp>,w:string,a:string,b:string,c:string,t:string,t2:string;
 async function request(path:string,method='GET',actor=0,body?:any){
  const data=body===undefined?undefined:JSON.stringify(body);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method',method],...(data?[['payload',createHash('sha256').update(data).digest('hex')]]:[])]},secrets[actor]!);
  const response=await app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'Content-Type':'application/json'},body:data});return {status:response.status,body:await response.json() as any};
 }
 beforeAll(async()=>{
  const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${name}`);await admin.end();db=postgres({...conn,database:name});
  for(const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8')))await db.unsafe(statement);
  const actors=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${nip19.npubEncode(getPublicKey(secrets[0]!))},'human'),(${nip19.npubEncode(getPublicKey(secrets[1]!))},'human') RETURNING id`;[a,b]=actors.map(r=>r.id);
  const [ws]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service','owner','app','Pins fixture') RETURNING id`;w=ws!.id;
  for(const id of [a,b])await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${id},'member')`;
  const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'Pins fixture','project') RETURNING id`;
  const [channel]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'Pins') RETURNING id`;c=channel!.id;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${c},'channel.read')`;
  const threads=await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${w},${scope!.id},${c},'First',${a},${a}),(${w},${scope!.id},${c},'Second',${a},${a}) RETURNING id`;[t,t2]=threads.map(r=>r.id);
  setDb(db);await ensureRuntimeSchema();app=createApp();
 });
 afterAll(async()=>{await db?.end();const admin=postgres({...conn,database:'postgres'});await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);await admin.end();});
 const mutation=(pinned:boolean,version=0,extra={})=>({pinned,expected_row_version:version,mutation_id:crypto.randomUUID(),...extra});
 async function synchronized(actorId=a){let p=await readFlightDeckRecordPage({workspaceId:w,actorId},db);while(p.has_more)p=await readFlightDeckRecordPage({workspaceId:w,actorId,cursor:p.next_cursor},db);return p.next_cursor;}
 test('two delta clients receive pin/unpin; tombstones and exact retries survive later mutations',async()=>{
  const devices=await Promise.all([synchronized(),synchronized()]);
  const input=mutation(true);const pin=await mutateThreadPin(w,a,t,input,db);
  const next=await mutateThreadPin(w,a,t,mutation(false,pin.row_version),db);
  expect(next.pinned).toBe(false);
  expect((await mutateThreadPin(w,a,t,input,db)).row_version).toBe(pin.row_version);
  for(const cursor of devices){const p=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor},db);expect(p.changes.filter(r=>r.family==='thread_pin').at(-1)?.row?.pinned).toBe(false);}
  expect((await mutateThreadPin(w,a,t,mutation(true,0,{import_only:true}),db)).pinned).toBe(false);
  await expect(mutateThreadPin(w,a,t,mutation(true,1),db)).rejects.toMatchObject({code:'thread_pin_conflict'});
  await expect(mutateThreadPin(w,a,t,{...input,pinned:false},db)).rejects.toMatchObject({code:'mutation_id_reused'});
 });
 test('concurrent independent imports merge; repeated/stale migration cannot resurrect; same-thread race has one winner',async()=>{
  const missing=crypto.randomUUID();
  await Promise.all([mutateThreadPin(w,a,t2,mutation(true,0,{import_only:true,pinned_at:'2026-10-01T00:00:00Z'}),db),mutateThreadPin(w,a,missing,mutation(true,0,{import_only:true}),db)]);
  expect((await db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} AND actor_id=${a} AND pinned`).length).toBe(2);
  const results=await Promise.allSettled([0,1].map(()=>mutateThreadPin(w,a,t2,mutation(false,1),db)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await mutateThreadPin(w,a,t2,mutation(true,0,{import_only:true}),db)).pinned).toBe(false);
  expect((await mutateThreadPin(w,a,missing,mutation(false,1),db)).pinned).toBe(false);
 });
 test('signed routes reject actor overrides and foreign/forbidden targets; deltas/SSE/audiences stay private',async()=>{
  const path=`/api/v4/flightdeck-pg/workspaces/${w}/me/thread-pins/${t}`;
  expect((await request(path,'PUT',0,{...mutation(true,2),actor_id:b})).status).toBe(400);
  expect((await request(path,'PUT',1,mutation(true))).status).toBe(403);
  expect((await request(path,'PUT',0,mutation(true,2))).status).toBe(200);
  const hidden=await readFlightDeckRecordPage({workspaceId:w,actorId:b},db);expect(hidden.changes.some(r=>r.family==='thread_pin')).toBe(false);
  expect((await listVisibleFlightDeckPgEvents({workspaceId:w,actorId:b,groupIds:[],afterRowVersion:0,limit:200,includeWorkspaceEvents:true},db)).some(e=>e.entity_type==='thread_pin')).toBe(false);
  expect((await listVisibleFlightDeckPgEvents({workspaceId:w,actorId:a,groupIds:[],afterRowVersion:0,limit:200,includeWorkspaceEvents:true},db)).some(e=>e.entity_type==='thread_pin')).toBe(true);
  expect((await listVisibleFlightDeckPgEventsForAudience({workspaceId:w,afterRowVersion:0,limit:200,audience:[{actorId:a,npub:'reader',groupIds:[],includeWorkspaceEvents:true}]},db)).events.some(({event})=>event.entity_type==='thread_pin')).toBe(false);
  const [other]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','other','owner','app','Other') RETURNING id`;
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${other!.id},${a},'member')`;
  expect((await request(`/api/v4/flightdeck-pg/workspaces/${other!.id}/me/thread-pins/${t}`,'PUT',0,mutation(true))).status).toBe(404);
  const imported=await mutateThreadPin(other!.id,a,t,mutation(true,0,{import_only:true}),db);expect(imported.channel_id).toBeNull();
 });
 test('pin writes leave thread, activity and read state unchanged; idempotent runtime migration retains tombstones',async()=>{
  const before=(await db`SELECT * FROM flightdeck_pg_threads WHERE id=${t}`)[0];
  const receipts=await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${w}`;
  await mutateThreadPin(w,a,t,mutation(false,3),db);
  expect((await db`SELECT * FROM flightdeck_pg_threads WHERE id=${t}`)[0]).toEqual(before);
  expect([...(await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${w}`)]).toEqual([...receipts]);
  await ensureRuntimeSchema();await ensureRuntimeSchema();
  expect((await mutateThreadPin(w,a,t,mutation(true,0,{import_only:true}),db)).pinned).toBe(false);
 });
});
