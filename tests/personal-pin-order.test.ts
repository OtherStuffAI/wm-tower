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
import { movePersonalPin } from '../src/services/personal-pin-order';
import { mutateThreadPin, mutatePersonalPin } from '../src/services/thread-pins';
import { listVisibleFlightDeckPgEvents, listVisibleFlightDeckPgEventsForAudience } from '../src/services/flightdeck-pg-api';
const port=Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port===5432)('personal pin ordering against isolated Postgres',()=>{
 const name=`pin_order_${process.pid}_${Date.now()}`, conn={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
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
 const ref=(r:any)=>({resource_type:r.resource_type,resource_id:r.resource_id,expected_row_version:r.row_version});
 const move=(r:any,before:any=null)=>({...ref(r),before:before?ref(before):null,mutation_id:crypto.randomUUID()});
 const path=()=>`/api/v4/flightdeck-pg/workspaces/${w}/me/pin-order`;
 const current=()=>db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} AND actor_id=${a} AND pinned ORDER BY order_position ASC NULLS FIRST, CASE WHEN order_position IS NULL THEN pinned_at END DESC,resource_type COLLATE "C",resource_id`;
 test('migration is additive, repeatable, preserves legacy state/receipts/history and normalizes first move',async()=>{
  const one=await mutateThreadPin(w,a,t,mutation(true,0,{import_only:true,pinned_at:'2026-10-01T00:00:00Z'}),db);
  const two=await mutateThreadPin(w,a,t2,mutation(true,0,{import_only:true,pinned_at:'2026-10-02T00:00:00Z'}),db);
  const dead=await mutateThreadPin(w,a,crypto.randomUUID(),mutation(false),db);
  await db`ALTER TABLE flightdeck_pg_thread_pins DROP COLUMN order_position`;
  // Real pre-upgrade canonical bodies omit the field. Capture those bodies with
  // the old table shape, then retain the already-synced browser cursor.
  await db`UPDATE flightdeck_pg_thread_pins SET pinned=pinned WHERE workspace_id=${w}`;
  const oldSnapshot=await readFlightDeckRecordPage({workspaceId:w,actorId:a},db);
  expect(oldSnapshot.changes.filter(r=>r.family==='personal_pin').every(r=>!Object.hasOwn(r.row!,'order_position'))).toBe(true);
  const oldCursor=await synchronized();
  const before=[...(await db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} ORDER BY id`)];
  const receipts=[...(await db`SELECT * FROM flightdeck_pg_thread_pin_mutations WHERE workspace_id=${w} ORDER BY mutation_id`)];
  const clock=[...(await db`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`)];
  const migration=readFileSync(new URL('../src/schema/personal-pin-order-v1.sql',import.meta.url),'utf8');
  await db.unsafe(migration);await db.unsafe(migration);
  const quiet=await request(`/api/v4/flightdeck-pg/workspaces/${w}/record-sync?protocol_version=1&cursor=${oldCursor}`);
  expect(quiet.status).toBe(200);expect(quiet.body.mode).toBe('delta');expect(quiet.body.changes).toEqual([]);
  expect(quiet.body.personal_pin_order_version).toBe(1);
  expect((await current()).map(r=>r.resource_id)).toEqual([t2,t]);
  const after=await db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} ORDER BY id`;
  expect(after.map(({order_position,...r})=>r)).toEqual(before);expect(after.every(r=>r.order_position===null)).toBe(true);
  expect([...(await db`SELECT * FROM flightdeck_pg_thread_pin_mutations WHERE workspace_id=${w} ORDER BY mutation_id`)]).toEqual(receipts);
  expect([...(await db`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`)]).toEqual(clock);
  const result=await movePersonalPin(w,a,move(one,two),db);
  expect(result.map(r=>r.resource_id)).toEqual([t,t2]);expect(result.map(r=>r.order_position)).toEqual([0,1]);
  expect((await db`SELECT * FROM flightdeck_pg_thread_pins WHERE id=${dead.id}`)[0]).toMatchObject({pinned:false,row_version:1,order_position:null});
 });
 test('signed move persists and two private clients converge; exact retry after unpin cannot resurrect',async()=>{
  const rows=await current(),input=move(rows[0]);
  const cursors=await Promise.all([synchronized(),synchronized()]),hiddenCursor=await synchronized(b);
  const sync=await request(`/api/v4/flightdeck-pg/workspaces/${w}/record-sync?protocol_version=1`);expect(sync.status).toBe(200);expect(sync.body.personal_pin_order_version).toBe(1);
  const resources=[...(await db`SELECT * FROM flightdeck_pg_threads WHERE workspace_id=${w} ORDER BY id`)];
  const reads=[...(await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${w}`)];
  const response=await request(path(),'POST',0,input);expect(response.status).toBe(200);
  const ack=response.body.pins;expect(ack.map((r:any)=>r.resource_id)).toEqual([t2,t]);
  expect((await current()).map(r=>[r.resource_id,r.order_position,r.row_version])).toEqual(ack.map((r:any)=>[r.resource_id,r.order_position,r.row_version]));
  for(const cursor of cursors){const p=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor},db);const pins=p.changes.filter(r=>r.family==='personal_pin');expect(pins).toHaveLength(2);expect(pins.every(r=>typeof r.row?.order_position==='number')).toBe(true);}
  expect((await readFlightDeckRecordPage({workspaceId:w,actorId:b,cursor:hiddenCursor},db)).changes.some(r=>r.family==='personal_pin')).toBe(false);
  const snapshot=await readFlightDeckRecordPage({workspaceId:w,actorId:a},db);expect(snapshot.changes.some(r=>r.family==='personal_pin'&&r.row?.order_position===0)).toBe(true);
  const moved=ack.find((r:any)=>r.resource_id===t);
  await mutateThreadPin(w,a,t,mutation(false,moved.row_version),db);
  const replay=await request(path(),'POST',0,input);expect(replay.body.pins).toEqual(ack);
  expect((await db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} AND actor_id=${a} AND resource_id=${t}`)[0]!.pinned).toBe(false);
  expect((await request(path(),'POST',0,{...input,before:ref(ack[0])})).body.error).toBe('mutation_id_reused');
  expect((await request(path(),'POST',0,{...input,mutation_id:crypto.randomUUID()})).body.error).toBe('pin_order_conflict');
  await expect(mutateThreadPin(w,a,t,{pinned:true,expected_row_version:moved.row_version,mutation_id:input.mutation_id},db)).rejects.toMatchObject({code:'mutation_id_reused'});
  expect([...(await db`SELECT * FROM flightdeck_pg_threads WHERE workspace_id=${w} ORDER BY id`)]).toEqual(resources);
  expect([...(await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${w}`)]).toEqual(reads);
 });
 test('strict signed auth/body, actor/app/workspace isolation, no target read escalation, private SSE',async()=>{
  const row=(await current())[0],input=move(row);
  for(const extra of [{actor_id:b},{before:ref(row)},{before:{}},{before:undefined},{expected_row_version:0}])expect((await request(path(),'POST',0,{...input,...extra})).status).toBe(400);
  expect((await request(path(),'POST',1,input)).status).toBe(409);
  const foreignPath=`/api/v4/flightdeck-pg/workspaces/${crypto.randomUUID()}/me/pin-order`;
  expect((await request(foreignPath,'POST',0,input)).status).not.toBe(200);
  const appScoped=await request(path()+'?app_npub=wrong-app','POST',0,input);
  expect(appScoped.status).toBe(200);expect(appScoped.body.identity.app_npub).toBe('app');
  const unsigned=await app.request(path(),{method:'POST',body:JSON.stringify(input)});expect(unsigned.status).not.toBe(200);
  // A retained unavailable pin remains movable; ordering cannot read resource bodies.
  await db`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${w} AND principal_actor_id=${a}`;
  expect((await request(path(),'POST',0,input)).status).toBe(200);
  const own=await listVisibleFlightDeckPgEvents({workspaceId:w,actorId:a,groupIds:[],afterRowVersion:0,limit:200,includeWorkspaceEvents:true},db);
  expect(own.some(e=>e.entity_type==='personal_pin')).toBe(true);
  expect((await listVisibleFlightDeckPgEvents({workspaceId:w,actorId:b,groupIds:[],afterRowVersion:0,limit:200,includeWorkspaceEvents:true},db)).some(e=>e.entity_type==='personal_pin')).toBe(false);
  expect((await listVisibleFlightDeckPgEventsForAudience({workspaceId:w,afterRowVersion:0,limit:200,audience:[{actorId:a,npub:'reader',groupIds:[],includeWorkspaceEvents:true}]},db)).events.some(({event})=>event.entity_type==='personal_pin')).toBe(false);
  await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${w} AND actor_id=${b}`;
  await expect(movePersonalPin(w,b,input,db)).rejects.toMatchObject({status:403});
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${b},'member')`;
 });
 test('concurrent moves conflict safely; additions survive; stale anchor/unpin never recreate a selection; repin is new-first',async()=>{
  // Imports deliberately allow unavailable fixtures and exercise mixed typed identity.
  const [row]=await current();
  const addition=await mutateThreadPin(w,a,crypto.randomUUID(),mutation(true,0,{import_only:true}),db);
  const input=move(row,addition);
  const results=await Promise.allSettled([movePersonalPin(w,a,input,db),movePersonalPin(w,a,{...input,mutation_id:crypto.randomUUID()},db)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const added=await mutateThreadPin(w,a,crypto.randomUUID(),mutation(true,0,{import_only:true}),db);
  const priorRows=await current(),moving=priorRows.find(r=>r.id===row.id)!;
  const pending=move(moving);await movePersonalPin(w,a,pending,db);
  expect((await current()).some(r=>r.id===added.id)).toBe(true);
  const selected=(await current())[0],anchor=(await current())[1];
  const stale=move(selected,anchor);await mutateThreadPin(w,a,anchor.resource_id,mutation(false,anchor.row_version),db);
  await expect(movePersonalPin(w,a,stale,db)).rejects.toMatchObject({code:'pin_order_conflict'});
  const [tombstone]=await db`SELECT * FROM flightdeck_pg_thread_pins WHERE id=${anchor.id}`;expect(tombstone!.pinned).toBe(false);
  // Explicit authorized repin resets its historical position; repeat true retains it.
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${c},'channel.read')`;
  const [old]=await db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} AND actor_id=${a} AND resource_id=${t} AND resource_type='thread'`;
  const repin=await mutateThreadPin(w,a,t,mutation(true,old!.row_version),db);expect(repin.order_position).toBeNull();
  expect((await current())[0]!.id).toBe(repin.id);
  const same=await movePersonalPin(w,a,move(repin),db),positioned=same.find(r=>r.id===repin.id)!;
  expect((await mutateThreadPin(w,a,t,mutation(true,positioned.row_version),db)).order_position).toBe(positioned.order_position);
 });
 test('mixed same-UUID selection and concurrent creation survive a move; stale target cannot resurrect',async()=>{
  const [channel]=await db`SELECT scope_id FROM flightdeck_pg_channels WHERE id=${c}`;
  await db`INSERT INTO flightdeck_pg_channels(id,workspace_id,scope_id,name) VALUES(${t},${w},${channel!.scope_id},'Typed channel')`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${w},'actor',${a},'channel',${t},'channel.read')`;
  const rows=await current(),input=move(rows[rows.length-1],rows[0]);
  await Promise.all([movePersonalPin(w,a,input,db),mutatePersonalPin(w,a,'channel',t,mutation(true),db)]);
  const pins=await current();expect(pins.filter(r=>r.resource_id===t).map(r=>r.resource_type).sort()).toEqual(['channel','thread']);
  const typed=pins.find(r=>r.resource_type==='channel')!;
  const requestBody=move(typed,pins.find(r=>r.resource_type==='thread'));
  const beforeRead=[...(await db`SELECT * FROM flightdeck_pg_channels WHERE id=${t}`)];
  await mutatePersonalPin(w,a,'channel',t,mutation(false,typed.row_version),db);
  expect((await request(path(),'POST',0,requestBody)).body.error).toBe('pin_order_conflict');
  expect((await current()).some(r=>r.resource_type==='thread'&&r.resource_id===t)).toBe(true);
  expect((await db`SELECT pinned FROM flightdeck_pg_thread_pins WHERE id=${typed.id}`)[0]!.pinned).toBe(false);
  expect([...(await db`SELECT * FROM flightdeck_pg_channels WHERE id=${t}`)]).toEqual(beforeRead);
 });

 test('transaction failure leaves no partial positions/journal/receipt and immutable retry succeeds',async()=>{
  await db`UPDATE flightdeck_pg_thread_pins SET order_position=NULL,row_version=row_version+1 WHERE workspace_id=${w} AND actor_id=${a} AND pinned`;
  const rows=await current(),input=move(rows[rows.length-1],rows[0]);
  const journal=[...(await db`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`)];
  const events=[...(await db`SELECT * FROM flightdeck_pg_outbox_events WHERE workspace_id=${w} ORDER BY id`)];
  await db.unsafe(`CREATE FUNCTION pin_order_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.order_position=1 THEN RAISE EXCEPTION 'injected move failure'; END IF; RETURN NEW; END $$`);
  await db.unsafe(`CREATE TRIGGER pin_order_test_fail BEFORE UPDATE ON flightdeck_pg_thread_pins FOR EACH ROW EXECUTE FUNCTION pin_order_test_fail()`);
  try { await expect(movePersonalPin(w,a,input,db)).rejects.toThrow('injected move failure'); }
  finally { await db.unsafe('DROP TRIGGER pin_order_test_fail ON flightdeck_pg_thread_pins'); await db.unsafe('DROP FUNCTION pin_order_test_fail()'); }
  expect([...(await current())]).toEqual([...rows]);
  expect([...(await db`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`)]).toEqual(journal);
  expect([...(await db`SELECT * FROM flightdeck_pg_outbox_events WHERE workspace_id=${w} ORDER BY id`)]).toEqual(events);
  expect(await db`SELECT * FROM flightdeck_pg_thread_pin_mutations WHERE workspace_id=${w} AND actor_id=${a} AND mutation_id=${input.mutation_id}`).toHaveLength(0);
  const ack=await movePersonalPin(w,a,input,db);expect(ack[0]!.id).toBe(rows[rows.length-1]!.id);
  expect(await movePersonalPin(w,a,input,db)).toEqual(JSON.parse(JSON.stringify(ack)));
 });

});
