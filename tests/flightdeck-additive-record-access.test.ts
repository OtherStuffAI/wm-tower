import { beforeAll, afterAll, test, describe, expect } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { registerRecordClient, readRecordCheckpoint, acknowledgeRecordCheckpoint } from '../src/services/flightdeck-record-checkpoints';
import { createFlightDeckPgChannel, createFlightDeckPgChannelGrants } from '../src/services/flightdeck-pg-api';
import { authorizeFlightDeckPgOperation } from '../src/services/flightdeck-pg-authorization';
import type { FlightDeckPgPermission, FlightDeckRecordPage, FlightDeckRecordPageV2 } from '../src/types';

// Explicit disposable endpoint; database creation, fixtures and teardown never
// touch the runtime or a shared workspace. No operational identities/keys.
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('additive reader access on an isolated database', () => {
  const database = `tower_additive_${process.pid}_${Date.now()}`;
  const conn = {host:'127.0.0.1',port,username:'postgres',password:'postgres',onnotice:()=>{}};
  let db: ReturnType<typeof postgres>;
  beforeAll(async () => {
    const admin = postgres({...conn,database:'postgres'});
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({...conn,database});
    for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8'))) await db.unsafe(stmt);
  });
  afterAll(async () => {
    await db?.end(); const admin=postgres({...conn,database:'postgres'});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });
  type Fixture = {workspaceId:string;actorId:string;secondActorId:string;scopeId:string;actors:{id:string;npub:string}[];main:Awaited<ReturnType<typeof createFlightDeckPgChannel>>};
  async function fixture():Promise<Fixture> {
    const actors = await db<{id:string;npub:string}[]>`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${`npub1fixture${randomUUID()}`},'human'),(${`npub1fixture${randomUUID()}`},'human') RETURNING id,npub`;
    const [w]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
      VALUES('fixture-tower',${randomUUID()},${actors[0]!.npub},'fixture-app','Additive') RETURNING id`;
    const workspaceId=w!.id, actorId=actors[0]!.id, secondActorId=actors[1]!.id;
    for(const a of actors) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${a.id},'member')`;
    const [s]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Project','project') RETURNING id`;
    const f={workspaceId,actorId,secondActorId,scopeId:s!.id,actors};
    const main=await channel(f,'Settled');
    for(const a of actors) for(const p of ['channel.read','task.read','doc.read']) await grant(f,main.id,a.id,p);
    await message(f,main.id,'Unrelated settled history');
    return {...f,main};
  }
  async function channel(f: Pick<Fixture,'workspaceId'|'scopeId'|'actorId'>,name:string) {
    return createFlightDeckPgChannel({workspaceId:f.workspaceId,scopeId:f.scopeId,name,kind:'channel',createdByActorId:f.actorId},db);
  }
  async function grant(f: Pick<Fixture,'workspaceId'>,channelId:string,actorId:string,permission:string,group=false) {
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,principal_group_id,resource_type,resource_channel_id,permission)
      VALUES(${f.workspaceId},${group?'group':'actor'},${group?null:actorId},${group?actorId:null},'channel',${channelId},${permission})`;
  }
  async function message(f: Pick<Fixture,'workspaceId'|'scopeId'|'actorId'>,channelId:string,body:string) {
    const [r]=await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${channelId},${body},${f.actorId},${f.actorId}) RETURNING id`;
    return r!.id;
  }
  function page(f: Fixture, cursor?:string, actorId=f.actorId, limit=200) {
    return readFlightDeckRecordPage({workspaceId:f.workspaceId,actorId,cursor,limit},db);
  }
  async function settle(f:Fixture,actorId=f.actorId) {
    let p=await page(f,undefined,actorId); let n=0;
    while(p.has_more) {p=await page(f,p.next_cursor,actorId); if(++n>100) throw Error('unbounded bootstrap');}
    return p.next_cursor;
  }
  async function device(f:Fixture,actorId=f.secondActorId) {
    const input={workspaceId:f.workspaceId,actorId,clientId:randomUUID()};
    const c=await registerRecordClient(input,db);
    let cursor=c.initial_cursor, revision=c.checkpoint_revision;
    const read=(limit=200,connection=db)=>readFlightDeckRecordPage({...input,protocolVersion:2,cursor,limit},connection);
    async function commit(p:FlightDeckRecordPageV2) {
      const ack=await acknowledgeRecordCheckpoint({...input,cursor:p.next_cursor,expectedRevision:p.checkpoint_revision},db);
      cursor=p.next_cursor;revision=ack.checkpoint_revision;return ack;
    }
    for(let n=0;n<100;n++) {const p=await read();await commit(p);if(!p.has_more) return {input,read,commit,get cursor(){return cursor},get revision(){return revision}};}
    throw Error('unbounded device bootstrap');
  }
  async function drain(f:Fixture,cursor:string,actorId=f.actorId,limit=200) {
    const pages:FlightDeckRecordPage[]=[];
    for(let n=0;n<150;n++) {const p=await page(f,cursor,actorId,limit);pages.push(p);cursor=p.next_cursor;if(!p.has_more)return {pages,cursor,changes:pages.flatMap(p=>p.changes)};}
    throw Error('unbounded catchup');
  }
  async function state(cursor:string) {
    const [row]=await db`SELECT state FROM flightdeck_pg_record_cursors WHERE token=${cursor}`;return row!.state;
  }

  test('atomic create route services plus creator/initial grants preserve two settled readers and checkpoints',async()=>{
    const f=await fixture(), cursor=await settle(f), d=await device(f);
    const [before]=await db`SELECT epoch,position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${f.workspaceId}`;
    const checkpoint=await readRecordCheckpoint(d.input,db);
    const created=await db.begin(async tx=>{
      const sql=tx as unknown as typeof db;
      const c=await createFlightDeckPgChannel({workspaceId:f.workspaceId,scopeId:f.scopeId,name:'New empty',kind:'channel',createdByActorId:f.actorId},sql);
      const creator:FlightDeckPgPermission[]=['channel.read','channel.write','channel.manage','channel.grant','channel.grants.read','channel.grants.manage','task.read','task.create','task.update','task.comment','comment.create','doc.read','doc.write','file.read','file.write','audio_note.read','audio_note.write'];
      await createFlightDeckPgChannelGrants({workspaceId:f.workspaceId,channel:c,principalType:'actor',principalId:f.actorId,permissions:creator,createdByActorId:f.actorId},sql);
      await createFlightDeckPgChannelGrants({workspaceId:f.workspaceId,channel:c,principalType:'actor',principalId:f.secondActorId,permissions:['channel.read','task.read'],createdByActorId:f.actorId},sql);
      return c;
    });
    const [after]=await db`SELECT epoch,position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${f.workspaceId}`;
    expect(after!.epoch).toBe(before!.epoch);expect(BigInt(after!.position)-BigInt(before!.position)).toBe(1n);
    const unchanged=await readRecordCheckpoint(d.input,db);
    expect(unchanged.checkpoint_cursor).toBe(checkpoint.checkpoint_cursor);expect(unchanged.checkpoint_revision).toBe(checkpoint.checkpoint_revision);
    const p=await page(f,cursor), q=await d.read();
    for(const response of [p,q]) {
      expect(response.mode).toBe('delta');expect(response.catchup).toBeNull();expect(response.has_more).toBe(false);
      expect(response.changes.map(c=>[c.family,c.id])).toEqual([['channel',created.id]]);
      expect(response.access_changes?.every(c=>c.resource_id===created.id)).toBe(true);
      expect(response.retention_policy).toBe('retain_downloaded');
    }
    expect((await state(p.next_cursor)).after).toBe(after!.position);
    await d.commit(q);expect((await d.read()).next_cursor).toBe(d.cursor);
    expect((await page(f,p.next_cursor)).next_cursor).toBe(p.next_cursor);
    const retry=await acknowledgeRecordCheckpoint({...d.input,cursor:q.next_cursor,expectedRevision:q.checkpoint_revision},db);
    expect(retry.checkpoint_cursor).toBe(q.next_cursor);
  });

  test('existing-history gain catches up only newly readable families without rewinding ordinary cursor; retries are bounded',async()=>{
    const f=await fixture(), hidden=await channel(f,'Existing hidden');
    const ids=[];for(let n=0;n<8;n++)ids.push(await message(f,hidden.id,`historic ${n}`));
    const [storage]=await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,storage_path)
      VALUES('fixture-owner','fixture-creator','historic-doc','text/plain',${randomUUID()}) RETURNING id`;
    const [doc]=await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${hidden.id},${storage!.id},'Historic doc',${f.actorId},${f.actorId}) RETURNING id`;
    const cursor=await settle(f), unrelated=await settle(f,f.secondActorId), initial=await state(cursor);
    await grant(f,hidden.id,f.actorId,'channel.read');
    const first=await page(f,cursor,f.actorId,2), replay=await page(f,cursor,f.actorId,2);
    expect(first.changes).toEqual(replay.changes);expect(first.access_changes).toEqual(replay.access_changes);
    const result=await drain(f,first.next_cursor,f.actorId,2), all=[...first.changes,...result.changes];
    expect(all.every(c=>c.channel_id===hidden.id)).toBe(true);
    expect(new Set(all.filter(c=>c.family==='message').map(c=>c.id))).toEqual(new Set(ids));
    expect(all.some(c=>c.id===doc!.id)).toBe(true);
    expect(result.pages.every(p=>p.mode==='delta'&&!p.snapshot_complete&&!p.partitions_complete.length)).toBe(true);
    expect((await state(result.cursor)).after).toBe(initial.after);
    const unaffected=await page(f,unrelated,f.secondActorId);expect(unaffected.changes).toEqual([]);expect(unaffected.next_cursor).toBe(unrelated);
    for(const p of [first,...result.pages])expect(p.changes.length+(p.actors?.length??0)+(p.access_changes?.length??0)).toBeLessThanOrEqual(200);
  });

  test('narrow task/doc gains catch up their watermarks without unrelated message or already-readable task replay',async()=>{
    const f=await fixture(), hidden=await channel(f,'Narrow family history');
    await message(f,hidden.id,'Not authorized by task/doc grants');
    const [task]=await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${hidden.id},'Narrow task',${f.actorId},${f.actorId}) RETURNING id`;
    const [storage]=await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,storage_path)
      VALUES('fixture-owner','fixture-creator','narrow-doc','text/plain',${randomUUID()}) RETURNING id`;
    const [doc]=await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${hidden.id},${storage!.id},'Narrow doc',${f.actorId},${f.actorId}) RETURNING id`;
    for(const [type,id] of [['task',task!.id],['document',doc!.id]]) await db`INSERT INTO flightdeck_pg_resource_view_states
      (workspace_id,scope_id,channel_id,viewer_actor_id,resource_type,resource_id)
      VALUES(${f.workspaceId},${f.scopeId},${hidden.id},${f.actorId},${type},${id})`;
    const cursor=await settle(f);
    await grant(f,hidden.id,f.actorId,'task.read');
    const tasks=await drain(f,cursor);expect(tasks.changes.map(c=>c.family).sort()).toEqual(['resource_view_state','task']);
    expect(tasks.changes.find(c=>c.family==='resource_view_state')!.row!.resource_type).toBe('task');
    await grant(f,hidden.id,f.actorId,'doc.read');
    const docs=await drain(f,tasks.cursor);expect(docs.changes.map(c=>c.family).sort()).toEqual(['doc','resource_view_state']);
    expect(docs.changes.find(c=>c.family==='resource_view_state')!.row!.resource_type).toBe('document');
    expect((await state(docs.cursor)).after).toBe((await state(cursor)).after);
  });

  test('nested group gain/loss affects only new partitions, with no unrelated reader replay',async()=>{
    const f=await fixture(), hidden=await channel(f,'Group history'), id=await message(f,hidden.id,'Group historic');
    const groups=await db`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${f.workspaceId},'Parent','custom'),(${f.workspaceId},'Child','custom') RETURNING id`;
    await grant(f,hidden.id,groups[0]!.id,'channel.read',true);
    await db`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${f.workspaceId},${groups[1]!.id},${f.actorId})`;
    const cursor=await settle(f), second=await settle(f,f.secondActorId);
    await db`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${f.workspaceId},${groups[0]!.id},${groups[1]!.id})`;
    const result=await drain(f,cursor);expect(result.changes.some(c=>c.id===id)).toBe(true);expect(result.changes.every(c=>c.channel_id===hidden.id)).toBe(true);
    expect((await page(f,second,f.secondActorId)).next_cursor).toBe(second);
    await db`DELETE FROM flightdeck_pg_group_edges WHERE workspace_id=${f.workspaceId} AND parent_group_id=${groups[0]!.id}`;
    await message(f,hidden.id,'Forbidden future');
    const lost=await drain(f,result.cursor);expect(lost.changes).toEqual([]);expect(lost.pages.flatMap(p=>p.access_changes??[]).some(c=>c.status==='lost')).toBe(true);
    await db`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${f.workspaceId},${groups[0]!.id},${groups[1]!.id})`;
    const rejoined=await drain(f,lost.cursor);expect(rejoined.changes.some(c=>c.row?.body==='Forbidden future')).toBe(true);
    await db`DELETE FROM flightdeck_pg_group_memberships WHERE workspace_id=${f.workspaceId} AND group_id=${groups[1]!.id}`;
    const removed=await drain(f,rejoined.cursor);expect(removed.changes).toEqual([]);
  });

  test('revocation filters old snapshots and future reads/writes while permitting idempotent ack of past downloads',async()=>{
    const f=await fixture(), d=await device(f), snapshot=await page(f,undefined,f.secondActorId,1);
    await message(f,f.main.id,'Before revocation');const issued=await d.read();
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspaceId} AND principal_actor_id=${f.secondActorId}`;
    const checkpoint=await readRecordCheckpoint(d.input,db);expect(checkpoint.checkpoint_cursor).toBe(d.cursor);
    await d.commit(issued);await message(f,f.main.id,'After revocation');
    const future=await d.read();expect(future.changes).toEqual([]);expect(future.access_changes?.some(c=>c.status==='lost')).toBe(true);
    const stale=await drain(f,snapshot.next_cursor,f.secondActorId);expect(stale.changes).toEqual([]);
    const decision=await authorizeFlightDeckPgOperation({workspaceId:f.workspaceId,actorNpub:f.actors[1]!.npub,appNpub:'fixture-app',permission:'channel.write',resource:{type:'channel',channelId:f.main.id}},db);
    expect(decision.allowed).toBe(false);
    await db`DELETE FROM flightdeck_pg_workspace_memberships WHERE workspace_id=${f.workspaceId} AND actor_id=${f.secondActorId}`;
    for(const operation of [()=>d.read(),()=>readRecordCheckpoint(d.input,db),()=>registerRecordClient(d.input,db),()=>acknowledgeRecordCheckpoint({...d.input,cursor:issued.next_cursor,expectedRevision:issued.checkpoint_revision},db)])
      await expect(operation()).rejects.toMatchObject({status:403,code:'workspace_membership_required'});
    await expect(page(f,stale.cursor,f.secondActorId)).rejects.toMatchObject({status:403});
  });

  test('authority changed during snapshot scan retries before delivering payload or sidecars',async()=>{
    const f=await fixture(), d=await device(f);await message(f,f.main.id,'Race secret');
    let enter!:()=>void,release!:()=>void,paused=false;
    const ready=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
    const connection=new Proxy(db,{get(target,key){if(key!=='begin')return Reflect.get(target,key);return (options:any,callback:any)=>target.begin(options,async tx=>{
      const wrapped=new Proxy(tx as unknown as typeof db,{apply(sql,self,args){
        if(!paused&&Array.isArray(args[0])&&args[0].join('').includes('FOR SHARE')){paused=true;enter();return gate.then(()=>Reflect.apply(sql,self,args));}
        return Reflect.apply(sql,self,args);
      }});return callback(wrapped);
    });}});
    const reading=d.read(200,connection);await ready;
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspaceId} AND principal_actor_id=${f.secondActorId}`;
    release();const response=await reading;
    expect(response.changes).toEqual([]);expect(response.actors).toEqual([]);expect(response.access_changes?.some(c=>c.status==='lost')).toBe(true);
  });

  test('runtime migration replaces installed reset triggers, preserves old cursors/checkpoints and is repeatable',async()=>{
    const f=await fixture();await ensureRuntimeSchema(db);
    const cursor=await settle(f), d=await device(f);
    const oldCheckpoint=await readRecordCheckpoint(d.input,db), original=await state(cursor);
    // Simulate the actually installed legacy trigger, not just fresh bootstrap.
    await db.unsafe(`CREATE OR REPLACE FUNCTION flightdeck_pg_record_reset() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      UPDATE flightdeck_pg_record_clock SET epoch=gen_random_uuid() WHERE workspace_id=COALESCE(to_jsonb(NEW)->>'workspace_id',to_jsonb(OLD)->>'workspace_id')::uuid;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$`);
    await db`UPDATE flightdeck_pg_record_cursors SET state=state-'access'-'accessRevision'-'progress' WHERE token=${cursor}`;
    await db`UPDATE flightdeck_pg_record_clients SET initial_state=initial_state-'access'-'accessRevision'-'progress',checkpoint_state=checkpoint_state-'access'-'accessRevision'-'progress' WHERE client_id=${d.input.clientId}`;
    const [before]=await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${f.workspaceId}`;
    await ensureRuntimeSchema(db);await ensureRuntimeSchema(db);
    const [definition]=await db`SELECT pg_get_functiondef('flightdeck_pg_record_reset()'::regprocedure) AS source`;
    expect(definition!.source).toContain('access_revision=access_revision+1');
    const c=await channel(f,'Migrated birth');await grant(f,c.id,f.actorId,'channel.read');
    const [after]=await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${f.workspaceId}`;expect(after!.epoch).toBe(before!.epoch);
    const freshCheckpoint=await readRecordCheckpoint(d.input,db);expect(freshCheckpoint.checkpoint_cursor).toBe(oldCheckpoint.checkpoint_cursor);expect(freshCheckpoint.checkpoint_revision).toBe(oldCheckpoint.checkpoint_revision);
    const result=await drain(f,cursor);expect(result.changes.map(c=>c.id)).toEqual([c.id]);expect((await state(cursor)).after).toBe(original.after);
  },30000);

  test('mid-snapshot gain catches earlier hidden keys; revoke cancels unfinished historic catchup',async()=>{
    const f=await fixture(), hidden=await channel(f,'Mid-snapshot history');
    for(let n=0;n<5;n++)await message(f,hidden.id,`Before grant ${n}`);
    await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
      VALUES(${f.workspaceId},${f.scopeId},${f.main.id},'Keeps snapshot open',${f.actorId},${f.actorId})`;
    let p=await page(f,undefined,f.actorId,1);
    while(p.mode==='snapshot' && (await state(p.next_cursor)).family<'scope') p=await page(f,p.next_cursor,f.actorId,1);
    expect((await state(p.next_cursor)).mode).toBe('snapshot');
    await grant(f,hidden.id,f.actorId,'channel.read');
    const gain=await page(f,p.next_cursor,f.actorId,1);
    expect(gain.access_changes?.some(c=>c.status==='granted')).toBe(true);
    const pending=await state(gain.next_cursor);expect(pending.catchups.length).toBeGreaterThan(0);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${f.workspaceId}
      AND principal_actor_id=${f.actorId} AND resource_channel_id=${hidden.id}`;
    const result=await drain(f,gain.next_cursor,f.actorId,1);
    expect(result.changes.some(c=>c.channel_id===hidden.id)).toBe(false);
    expect((await state(result.cursor)).catchups).toEqual([]);
  });

  test('activation verifier checks deployed function bodies and source/runtime SQL stay aligned',async()=>{
    const source=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8');
    const migration=readFileSync(new URL('../src/schema/additive-record-access-v1.sql',import.meta.url),'utf8');
    expect(source.split('-- additive_record_access_v1\n')[1]!.split('-- end_additive_record_access_v1')[0]!.trim()).toBe(migration.trim());
    const connection=await db.reserve();
    try {await connection.unsafe(readFileSync(new URL('../scripts/verify-additive-record-access.sql',import.meta.url),'utf8'));}
    finally {await connection.unsafe('ROLLBACK');connection.release();}
  });

  test('targeted catchup survives reconnect and v2 ack races without regressing progress; pruning is explicit',async()=>{
    const f=await fixture(), hidden=await channel(f,'Device history');
    for(let n=0;n<6;n++)await message(f,hidden.id,`Reconnect ${n}`);
    const d=await device(f);await grant(f,hidden.id,f.secondActorId,'channel.read');
    const p=await d.read(1);await d.commit(p);
    const resumed=await readRecordCheckpoint(d.input,db);expect(resumed.checkpoint_cursor).toBe(d.cursor);
    const first=await d.read(1), racing=await d.read(1);await d.commit(first);
    await expect(acknowledgeRecordCheckpoint({...d.input,cursor:racing.next_cursor,expectedRevision:racing.checkpoint_revision},db)).rejects.toMatchObject({code:'checkpoint_conflict'});
    const changes=[...p.changes,...first.changes];
    for(let n=0;n<100;n++){const q=await d.read(2);changes.push(...q.changes);await d.commit(q);if(!q.has_more)break;if(n===99)throw Error('unbounded reconnect');}
    expect(new Set(changes.filter(c=>c.family==='message').map(c=>c.id)).size).toBe(6);
    expect(changes.every(c=>c.channel_id===hidden.id)).toBe(true);
    await message(f,f.main.id,'Pruned ordinary history');await db`UPDATE flightdeck_pg_record_clock SET journal_floor=position WHERE workspace_id=${f.workspaceId}`;
    await expect(d.read()).rejects.toMatchObject({code:'history_pruned'});await expect(readRecordCheckpoint(d.input,db)).rejects.toMatchObject({code:'history_pruned'});
    const repaired=await registerRecordClient({...d.input,clientId:randomUUID()},db);expect(repaired.retention_policy).toBe('retain_downloaded');
  });
});
