import {test,expect} from 'bun:test';
import postgres from 'postgres';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setDb} from '../src/db';
import {splitSqlStatements} from '../src/schema/sql-statements';
import {ensureRuntimeSchema} from '../src/schema/ensure-runtime-schema';
import {mutateThreadPin} from '../src/services/thread-pins';
import {readFlightDeckRecordPage} from '../src/services/flightdeck-record-delta';
const port=Number(process.env.RECORD_TEST_PORT);
test.skipIf(!port||port===5432)('upgrades the real thread-only schema without losing tombstones, exact receipts or cursor ownership',async()=>{
 const name=`personal_pin_upgrade_${process.pid}_${Date.now()}`,options={host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
 const admin=postgres({...options,database:'postgres'});await admin.unsafe(`CREATE DATABASE ${name}`);await admin.end();const db=postgres({...options,database:name});
 try{
  const oldSchema=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8').split('-- Extend the thread checkpoint')[0]!;
  for(const stmt of splitSqlStatements(oldSchema))await db.unsafe(stmt);
  const [actor]=await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('npub1upgradefixture','human') RETURNING id`;
  const [workspace]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service','owner','app','Upgrade') RETURNING id`;
  const w=workspace!.id,a=actor!.id,t=crypto.randomUUID(),mutationId=crypto.randomUUID();
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${a},'member')`;
  const [old]=await db`INSERT INTO flightdeck_pg_thread_pins(workspace_id,actor_id,thread_id,pinned,row_version) VALUES(${w},${a},${t},false,3) RETURNING *`;
  const body={pinned:false,expected_row_version:2,mutation_id:mutationId},hash=createHash('sha256').update(JSON.stringify([t,false,2,false,null])).digest('hex');
  await db`INSERT INTO flightdeck_pg_thread_pin_mutations VALUES(${w},${a},${mutationId},${hash},${db.json(old as any)})`;
  let page=await readFlightDeckRecordPage({workspaceId:w,actorId:a},db);while(page.has_more)page=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor:page.next_cursor},db);
  const [clock]=await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`;
  setDb(db);await ensureRuntimeSchema();await ensureRuntimeSchema();
  const [pin]=await db`SELECT * FROM flightdeck_pg_thread_pins WHERE workspace_id=${w} AND actor_id=${a}`;
  expect(pin!.id).toBe(old!.id);expect(pin!.pinned).toBe(false);expect(pin!.row_version).toBe(3);expect(pin!.resource_type).toBe('thread');expect(pin!.resource_id).toBe(t);
  expect((await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${w}`)[0]!.epoch).toBe(clock!.epoch);
  const recovered=await readFlightDeckRecordPage({workspaceId:w,actorId:a,cursor:page.next_cursor},db);expect(recovered.mode).toBe('delta');expect(recovered.changes.some(c=>c.family==='personal_pin'&&c.row?.pinned===false)).toBe(true);
  const retried=await mutateThreadPin(w,a,t,body,db);expect(retried.id).toBe(old!.id);expect(retried.pinned).toBe(false);expect(retried.row_version).toBe(3);
  const imported=await mutateThreadPin(w,a,t,{pinned:true,expected_row_version:0,mutation_id:crypto.randomUUID(),import_only:true},db);expect(imported.pinned).toBe(false);
 }finally{await db.end();const cleanup=postgres({...options,database:'postgres'});await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name}`);await cleanup.end();}
},30000);
