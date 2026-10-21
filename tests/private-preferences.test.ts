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
import { readPrivatePreference, writePrivatePreference } from '../src/services/private-preferences';
import { listVisibleFlightDeckPgEvents, listVisibleFlightDeckPgEventsForAudience } from '../src/services/flightdeck-pg-api';
const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port===5432)('private preference real signed API against isolated Postgres',()=>{
 const name=`private_preferences_${process.pid}_${Date.now()}`, conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
 const secrets=[new Uint8Array(32).fill(119),new Uint8Array(32).fill(120)];
 let db:ReturnType<typeof postgres>,app:ReturnType<typeof createApp>,w:string,a:string,b:string,c:string,t:string,t2:string;
 async function request(path:string,method='GET',actor=0,body?:any){
  const data=body===undefined?undefined:JSON.stringify(body);
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',`http://localhost${path}`],['method',method],...(data?[['payload',createHash('sha256').update(data).digest('hex')]]:[])]},secrets[actor]!);
  const response=await app.request(path,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,'Content-Type':'application/json'},body:data});return {cacheControl:response.headers.get('cache-control'),status:response.status,body:await response.json() as any};
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

 const key='ambulando.nostr-viewer';
 const path=()=>`/api/v4/flightdeck-pg/workspaces/${w}/me/preferences/${key}`;
 const mutation=(value:string,version=0,extra={})=>({value,expected_row_version:version,mutation_id:crypto.randomUUID(),...extra});
 test('two independent signed API readers converge, including an authoritative default and exact retry',async()=>{
  const absent=await request(path());expect(absent.body.preference).toBeNull();expect(absent.cacheControl).toBe('private, no-store');
  const input=mutation('https://viewer.example/event/');
  const saved=await request(path(),'PUT',0,input);expect(saved.status).toBe(200);
  const [deviceOne,deviceTwo]=await Promise.all([request(path()),request(path())]);
  expect(deviceOne.body.preference).toEqual(deviceTwo.body.preference);
  expect(deviceTwo.body.preference.value).toBe(input.value);
  const reset=await request(path(),'PUT',0,mutation('https://njump.me/',1));expect(reset.status).toBe(200);
  expect((await request(path(),'PUT',0,input)).body.preference.row_version).toBe(1);
  expect((await request(path(),'PUT',0,mutation('stale',0,{import_only:true}))).body.preference.value).toBe('https://njump.me/');
  expect((await request(path(),'PUT',0,mutation('stale',1))).status).toBe(409);
  expect((await request(path(),'PUT',0,{...input,value:'changed'})).body.code).toBe('mutation_id_reused');
  const final=await Promise.all([request(path()),request(path())]);
  expect(final.map(r=>r.body.preference.value)).toEqual(['https://njump.me/','https://njump.me/']);
 });
 test('actor overrides, other actors/workspaces, private notifications and managed audiences stay isolated',async()=>{
  expect((await request(path(),'PUT',0,{...mutation('x',2),actor_id:b})).status).toBe(400);
  expect((await request(path(),'GET',1)).body.preference).toBeNull();
  expect((await request(path(),'PUT',1,mutation('bob'))).status).toBe(200);
  expect((await request(path())).body.preference.value).toBe('https://njump.me/');
  const events=(actorId:string)=>listVisibleFlightDeckPgEvents({workspaceId:w,actorId,groupIds:[],afterRowVersion:0,limit:200,includeWorkspaceEvents:true},db);
  for(const actor of [a,b])expect((await events(actor)).filter(e=>e.entity_type==='private_preference').every(e=>e.actor_id===actor)).toBe(true);
  expect((await listVisibleFlightDeckPgEventsForAudience({workspaceId:w,afterRowVersion:0,limit:200,audience:[{actorId:a,npub:'reader',groupIds:[],includeWorkspaceEvents:true}]},db)).events.some(({event})=>event.entity_type==='private_preference')).toBe(false);
  const [other]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','other','owner','app','Other') RETURNING id`;
  const otherPath=`/api/v4/flightdeck-pg/workspaces/${other!.id}/me/preferences/${key}`;
  expect((await request(otherPath)).status).toBe(403);
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${other!.id},${a},'member')`;
  expect((await request(otherPath)).body.preference).toBeNull();
  expect((await request(otherPath,'PUT',0,mutation('other workspace'))).status).toBe(200);
  expect((await request(path())).body.preference.value).toBe('https://njump.me/');
 });
 test('concurrent CAS has one winner; validation and repeated schema upgrade preserve state',async()=>{
  const race=await Promise.all(['one','two'].map(v=>request(path(),'PUT',0,mutation(v,2))));
  expect(race.map(r=>r.status).sort()).toEqual([200,409]);
  for(const input of [mutation('x'.repeat(2049),3),mutation('bad\nvalue',3),{...mutation('x',3),import_only:true},{...mutation('x',3),expected_row_version:-1}])expect((await request(path(),'PUT',0,input)).status).toBe(400);
  const before=await readPrivatePreference(w,a,key,db);
  await ensureRuntimeSchema();await ensureRuntimeSchema();
  expect(await readPrivatePreference(w,a,key,db)).toEqual(before);
 });
 test('membership loss hides private state without erasing authoritative resets on rejoin',async()=>{
  const before=await readPrivatePreference(w,b,key,db);
  await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${w} AND actor_id=${b}`;
  expect((await request(path(),'GET',1)).status).toBe(403);
  expect((await request(path(),'PUT',1,mutation('unauthorized',before!.row_version))).status).toBe(403);
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${b},'member')`;
  expect((await request(path(),'GET',1)).body.preference.value).toBe(before!.value);
  expect((await request(path(),'PUT',1,mutation('stale legacy',0,{import_only:true}))).body.preference.value).toBe(before!.value);
 });

});
