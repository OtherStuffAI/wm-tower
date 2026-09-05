import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { listEffectiveFlightDeckPgThreadMessages } from '../src/services/flightdeck-pg-api';
import { recordFamilies } from '../src/services/flightdeck-record-families';

// Explicit opt-in: this suite must never point at the shared runtime database.
const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('isolated record delta v1', () => {
const dbName = `tower_record_delta_${process.pid}`;
let db: ReturnType<typeof postgres>;
let workspaceId: string, actorId: string, scopeId: string, channelId: string;
const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
beforeAll(async () => {
  const admin = postgres({ ...conn, database: 'postgres' });
  await admin.unsafe(`CREATE DATABASE ${dbName}`); await admin.end();
  db = postgres({ ...conn, database: dbName });
  for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
  const [a] = await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES('npub1recordtest','human','Record Test') RETURNING id`; actorId = a!.id;
  const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id) VALUES('tower','workspace','owner','app','Record Test',${actorId}) RETURNING id`; workspaceId=w!.id;
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${actorId},'owner')`;
  const [s] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Test','project') RETURNING id`; scopeId=s!.id;
  const [c] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Test') RETURNING id`; channelId=c!.id;
  for (const permission of ['channel.read','task.read','doc.read']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'actor',${actorId},'channel',${channelId},${permission})`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission) VALUES(${workspaceId},'actor',${actorId},'scope',${scopeId},'scope.read')`;
});
afterAll(async () => { await db?.end(); });
async function message(body: string, sql = db) {
  const [r] = await sql`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},${body},${actorId},${actorId}) RETURNING *`;
  return r!;
}
async function page(cursor?: string, limit=200) { return readFlightDeckRecordPage({workspaceId,actorId,cursor,limit},db); }
async function synced() { let p=await page(); while(p.has_more) p=await page(p.next_cursor); return p.next_cursor; }

test('every advertised family has all-mutation trigger and complete canonical fixture columns', async () => {
  const fixtures=JSON.parse(readFileSync(new URL('./fixtures/flightdeck-record-delta-v1.json',import.meta.url),'utf8'));
  const fixtureActors = new Map(fixtures.canonical_upserts.actors.map((actor:any)=>[actor.actor_id,actor]));
  for(const change of fixtures.canonical_upserts.changes) for(const [key,id] of Object.entries(change.row)) {
    if ((key==='actor_id'||key.endsWith('_actor_id')) && id) expect(fixtureActors.has(id)).toBe(true);
  }
  for(const [family,table] of Object.entries(recordFamilies)) {
    const [trigger]=await db`SELECT tgtype FROM pg_trigger WHERE tgname=${`fd_record_${family}`}`;
    expect(Number(trigger!.tgtype)&(4|8|16)).toBe(4|8|16);
    const columns=await db`SELECT column_name FROM information_schema.columns WHERE table_name=${`flightdeck_pg_${table}`}`;
    const fixture=fixtures.canonical_upserts.changes.find((c:any)=>c.family===family);
    expect(Object.keys(fixture.row).sort()).toEqual(columns.map(c=>c.column_name).sort());
  }
});
test('sidecars resolve only visible typed references, deduplicate and bound identity expansion', async () => {
  const [hiddenActor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES('npub1hiddenactor','agent','Hidden') RETURNING id`;
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${hiddenActor!.id},'agent')`;
  const [hiddenChannel] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Hidden actors') RETURNING id`;
  await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${hiddenChannel!.id},'secret',${hiddenActor!.id},${hiddenActor!.id})`;
  const cursor = await synced();
  const msg = await message('visible author');
  await db`UPDATE flightdeck_pg_messages SET metadata=${db.json({actor_id:hiddenActor!.id})} WHERE id=${msg.id}`;
  const p = await page(cursor);
  expect(p.actors).toEqual([{actor_id:actorId,npub:'npub1recordtest',display_name:'Record Test',kind:'human'}]);
  expect(p.actors!.some(a=>a.actor_id===hiddenActor!.id)).toBe(false);
  let snap = await page();
  while (true) {
    expect(snap.actors!.some(a=>a.actor_id===hiddenActor!.id)).toBe(false);
    expect(snap.changes.length+snap.actors!.length).toBeLessThanOrEqual(200);
    if (!snap.has_more) break;
    snap = await page(snap.next_cursor);
  }
  const start = await synced();
  await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
    SELECT ${workspaceId},${scopeId},${channelId},'row bound',${actorId},${actorId} FROM generate_series(1,200)`;
  const bounded = await page(start);
  expect(bounded.changes.length).toBe(199);expect(bounded.actors!.length).toBe(1);expect(bounded.has_more).toBe(true);
  expect((await page(bounded.next_cursor)).changes.length).toBe(1);
  await db`DELETE FROM flightdeck_pg_messages WHERE workspace_id=${workspaceId} AND body='row bound'`;
});

test('actor label bytes defer the entire change without cursor loss and oversized identity fails', async () => {
  const [author] = await db`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES('npub1largeactor','agent',repeat('L',600000)) RETURNING id`;
  await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${author!.id},'agent')`;
  const start = await synced();
  await message('x'.repeat(500000));
  const [second] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},'second',${author!.id},${author!.id}) RETURNING id`;
  const first = await page(start);
  expect(first.changes.length).toBe(1);expect(first.actors!.some(a=>a.actor_id===author!.id)).toBe(false);
  const next = await page(first.next_cursor);
  expect(next.changes[0]!.id).toBe(second!.id);expect(next.actors![0]!.display_name!.length).toBe(600000);
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(1048576);
  await db`UPDATE flightdeck_pg_actors SET display_name=repeat('L',1100000) WHERE id=${author!.id}`;
  await expect(page(first.next_cursor)).rejects.toMatchObject({status:413,code:'record_too_large'});
  await db`UPDATE flightdeck_pg_actors SET display_name='restored' WHERE id=${author!.id}`;
});

test('canonical one-record delta, replay and explicit soft/hard deletion',async()=>{
  const cursor=await synced(); const m=await message('hello');
  const p=await page(cursor);expect(p.mode).toBe('delta');expect(p.changes.length).toBe(1);
  expect(p.changes[0]!.row!.body).toBe('hello');expect(p.changes[0]!.id).toBe(m.id);
  expect((await page(cursor)).changes).toEqual(p.changes);
  await db`UPDATE flightdeck_pg_messages SET deleted_at=now(),row_version=row_version+1 WHERE id=${m.id}`;
  const d=await page(p.next_cursor);expect(d.changes[0]!.operation).toBe('delete');expect(d.changes[0]!.row).toBeNull();
  await db`DELETE FROM flightdeck_pg_messages WHERE id=${m.id}`;
  expect((await page(d.next_cursor)).changes[0]!.operation).toBe('delete');
});
test('late commit cannot be skipped by a higher committed position; rollback is atomic',async()=>{
  const cursor=await synced();
  let release!:()=>void, allocated!:()=>void;
  const gate=new Promise<void>(r=>release=r);const ready=new Promise<void>(r=>allocated=r);
  const first=db.begin(async tx=>{await message('late',tx as unknown as typeof db);allocated();await gate;});
  await ready;
  let secondCommitted=false;
  const second=db.begin(async tx=>{await message('later',tx as unknown as typeof db);}).then(()=>{secondCommitted=true;});
  await new Promise(r=>setTimeout(r,30));expect(secondCommitted).toBe(false);
  expect((await page(cursor)).changes).toHaveLength(0);
  release();await Promise.all([first,second]);
  const result=await page(cursor);expect(result.changes.map(c=>c.row!.body)).toEqual(['late','later']);
  expect(BigInt(result.changes[1]!.version)>BigInt(result.changes[0]!.version)).toBe(true);
  try {await db.begin(async tx=>{await message('rolled back',tx as unknown as typeof db);throw new Error('rollback');});}catch{}
  expect((await page(result.next_cursor)).changes).toHaveLength(0);
});
test('snapshot races converge through handover with bounded scanned pages',async()=>{
  const m=await message('before');let p=await page(undefined,1);const snapshotId=p.snapshot_id;
  await db`UPDATE flightdeck_pg_messages SET body='after',row_version=row_version+1 WHERE id=${m.id}`;
  const inserted=await message('inserted during snapshot');
  const rows=new Map<string,any>();let pages=0;
  while(true){
    for(const c of p.changes){if(c.operation==='delete')rows.delete(c.id);else rows.set(c.id,c.row);}
    expect(p.changes.length).toBeLessThanOrEqual(1);
    if(p.mode==='snapshot')expect(p.snapshot_id).toBe(snapshotId);
    if(!p.has_more)break;
    p=await page(p.next_cursor,1);if(++pages>100)throw new Error('snapshot did not converge');
  }
  expect(rows.get(m.id).body).toBe('after');expect(rows.get(inserted.id).body).toBe('inserted during snapshot');
});
test('grant/revocation reset both delta and unfinished snapshot; actor-bound cursors',async()=>{
  const cursor=await synced(); const snap=await page(undefined,1);
  await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
  for(const token of [cursor,snap.next_cursor]) await expect(page(token)).rejects.toMatchObject({status:409,code:'reset_required'});
  const denied=await page();expect(denied.changes.some(c=>c.family==='message')).toBe(false);
  await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
  await expect(page(denied.next_cursor)).rejects.toMatchObject({status:409});
  await expect(page('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({status:409});
  await expect(page('legacy-cursor')).rejects.toMatchObject({status:400});
});
test('payload limits fail safely and split full canonical rows',async()=>{
  const cursor=await synced();
  const a=await message('x'.repeat(600_000));const b=await message('y'.repeat(600_000));
  const p=await page(cursor);expect(p.changes).toHaveLength(1);expect(p.has_more).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(1_048_576);
  const q=await page(p.next_cursor);expect(q.changes[0]!.id).toBe(b.id);
  const huge=await message('z'.repeat(1_048_576));
  await expect(page(q.next_cursor)).rejects.toMatchObject({status:413,code:'record_too_large'});
  await db`DELETE FROM flightdeck_pg_messages WHERE id IN (${a.id},${b.id},${huge.id})`;
});

test('dependent record hard deletions emit explicit tombstones',async()=>{
  const [task]=await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'Move me',${actorId},${actorId}) RETURNING *`;
  const [comment]=await db`INSERT INTO flightdeck_pg_task_comments(workspace_id,scope_id,channel_id,task_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},${task!.id},'comment',${actorId},${actorId}) RETURNING *`;
  const [clock]=await db`SELECT position::text,epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;
  // Start at current high water without replaying intentionally oversized historical fixture.
  const [token]=await db`INSERT INTO flightdeck_pg_record_cursors(workspace_id,actor_id,epoch,state) VALUES(${workspaceId},${actorId},${clock!.epoch},${db.json({mode:'delta',boundary:clock!.position,after:clock!.position,family:'',id:'',snapshotId:null})}) RETURNING token`;
  await db`DELETE FROM flightdeck_pg_task_comments WHERE id=${comment!.id}`;
  await db`DELETE FROM flightdeck_pg_tasks WHERE id=${task!.id}`;
  await expect(page(token!.token)).rejects.toMatchObject({status:409,code:'reset_required'});
  const p=await page();expect(p.changes.some(c=>c.id===comment!.id||c.id===task!.id)).toBe(false);
});

test('indexed message and task keysets preserve same-time ID ordering',async()=>{
  const {listFlightDeckPgChannelMessages,listFlightDeckPgChannelTasks}=await import('../src/services/flightdeck-pg-api');
  const timestamp='2026-01-01T00:00:00.123456Z';
  for(let n=0;n<5;n++)await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,created_at,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'tie',${timestamp},${actorId},${actorId})`;
  const seen:string[]=[];let afterCreatedAt:string|null=null,afterId:string|null=null;
  for(let n=0;n<3;n++){
    const rows=await listFlightDeckPgChannelMessages({workspaceId,channelId,limit:2,afterCreatedAt,afterId},db);
    seen.push(...rows.filter(r=>r.body==='tie').map(r=>r.id));
    const last=rows.at(-1)!;afterCreatedAt=(last as any).cursor_created_at;afterId=last.id;
  }
  expect(new Set(seen).size).toBe(5);expect(seen).toEqual([...seen].sort());
  for(let n=0;n<5;n++)await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,updated_at,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'tie task',${timestamp},${actorId},${actorId})`;
  const first=await listFlightDeckPgChannelTasks({workspaceId,channelId,limit:2,state:'new'},db);
  const next=await listFlightDeckPgChannelTasks({workspaceId,channelId,limit:3,state:'new',beforeUpdatedAt:(first[1] as any).cursor_updated_at,afterId:first[1]!.id},db);
  expect(new Set([...first,...next].map(r=>r.id)).size).toBe(5);
});


test('move produces old-ownership deletion followed by canonical destination upsert',async()=>{
  const [dest]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scopeId},'Destination') RETURNING id`;
  await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspaceId},'actor',${actorId},'channel',${dest!.id},'channel.read')`;
  const moved=await message('moving');const cursor=await synced();
  await db`UPDATE flightdeck_pg_messages SET channel_id=${dest!.id},row_version=row_version+1 WHERE id=${moved.id}`;
  const p=await page(cursor);
  expect(p.changes.map(c=>[c.operation,c.channel_id])).toEqual([['delete',channelId],['upsert',dest!.id]]);
});


test('scope metadata is incremental while archive and group membership force reset',async()=>{
  const cursor=await synced();
  await db`UPDATE flightdeck_pg_scopes SET description='renamed metadata' WHERE id=${scopeId}`;
  const changed=await page(cursor);expect(changed.changes).toHaveLength(1);expect(changed.changes[0]!.family).toBe('scope');
  await db`UPDATE flightdeck_pg_scopes SET archived_at=now() WHERE id=${scopeId}`;
  await expect(page(changed.next_cursor)).rejects.toMatchObject({status:409});
  await db`UPDATE flightdeck_pg_scopes SET archived_at=NULL WHERE id=${scopeId}`;
  const current=await synced();
  await db`UPDATE flightdeck_pg_group_memberships SET created_by_actor_id=${actorId} WHERE workspace_id=${workspaceId} AND actor_id=${actorId}`;
  await expect(page(current)).rejects.toMatchObject({status:409});
});

test('a snapshot-racing deletion cannot survive handover',async()=>{
  const doomed=await message('delete during snapshot');let p=await page(undefined,1);
  await db`DELETE FROM flightdeck_pg_messages WHERE id=${doomed.id}`;
  const seen=new Set<string>();let rounds=0;
  while(true){for(const c of p.changes){if(c.operation==='delete')seen.delete(c.id);else seen.add(c.id);}if(!p.has_more)break;p=await page(p.next_cursor,1);if(++rounds>100)throw new Error('no handover');}
  expect(seen.has(doomed.id)).toBe(false);
});


test('parent soft deletion resets cached dependents and excludes orphan comments/assignments/view states',async()=>{
  const [task]=await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},'parent',${actorId},${actorId}) RETURNING id`;
  const [comment]=await db`INSERT INTO flightdeck_pg_task_comments(workspace_id,scope_id,channel_id,task_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},${task!.id},'dependent',${actorId},${actorId}) RETURNING id`;
  await db`INSERT INTO flightdeck_pg_task_assignments(workspace_id,scope_id,channel_id,task_id,actor_id,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},${task!.id},${actorId},${actorId},${actorId})`;
  await db`INSERT INTO flightdeck_pg_resource_view_states(workspace_id,scope_id,channel_id,viewer_actor_id,resource_type,resource_id) VALUES(${workspaceId},${scopeId},${channelId},${actorId},'task',${task!.id})`;
  const cursor=await synced();await db`UPDATE flightdeck_pg_tasks SET deleted_at=now() WHERE id=${task!.id}`;
  await expect(page(cursor)).rejects.toMatchObject({status:409});
  let p=await page();const rows=[];while(true){rows.push(...p.changes);if(!p.has_more)break;p=await page(p.next_cursor);}
  expect(rows.some(c=>c.id===comment!.id||c.row?.task_id===task!.id||c.row?.resource_id===task!.id)).toBe(false);
});

test('document-only grants include canonical document watermarks; parent deletion excludes both',async()=>{
  const [storage]=await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,storage_path) VALUES('owner','creator','doc','text/plain','test-doc') RETURNING id`;
  const [doc]=await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspaceId},${scopeId},${channelId},${storage!.id},'Document',${actorId},${actorId}) RETURNING id`;
  await db`INSERT INTO flightdeck_pg_resource_view_states(workspace_id,scope_id,channel_id,viewer_actor_id,resource_type,resource_id) VALUES(${workspaceId},${scopeId},${channelId},${actorId},'document',${doc!.id})`;
  await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
  let p=await page();const changes=[];while(true){changes.push(...p.changes);if(!p.has_more)break;p=await page(p.next_cursor);}
  expect(changes.some(c=>c.family==='resource_view_state'&&c.row!.resource_id===doc!.id)).toBe(true);
  await db`UPDATE flightdeck_pg_docs SET deleted_at=now() WHERE id=${doc!.id}`;
  await expect(page(p.next_cursor)).rejects.toMatchObject({status:409});
  expect((await page()).changes.some(c=>c.row?.resource_id===doc!.id)).toBe(false);
  await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
});

test('idle polling reuses its cursor, progress retention is capped and expired replay resets',async()=>{
  const cursor=await synced();const [before]=await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_cursors`;
  for(let n=0;n<10;n++)expect((await page(cursor)).next_cursor).toBe(cursor);
  const [after]=await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_cursors`;expect(after!.n).toBe(before!.n);
  const [saved]=await db`SELECT * FROM flightdeck_pg_record_cursors WHERE token=${cursor}`;
  await db`DELETE FROM flightdeck_pg_record_cursors WHERE workspace_id=${workspaceId} AND token<>${cursor}`;
  await db`INSERT INTO flightdeck_pg_record_cursors(workspace_id,actor_id,epoch,state) SELECT ${workspaceId},${actorId},${saved!.epoch},${db.json(saved!.state)} FROM generate_series(1,511)`;
  await message('cursor progress');const progress=await page(cursor);
  const [count]=await db`SELECT count(*)::int AS n FROM flightdeck_pg_record_cursors WHERE workspace_id=${workspaceId}`;expect(count!.n).toBe(512);
  await db`UPDATE flightdeck_pg_record_cursors SET created_at=now()-interval '8 days' WHERE token=${progress.next_cursor}`;
  await expect(page(progress.next_cursor)).rejects.toMatchObject({status:409});
});

test('driver payload stays bounded for 200 large visible and hidden records',async()=>{
  await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,body,metadata,created_by_actor_id,updated_by_actor_id)
    SELECT ${workspaceId},${scopeId},${channelId},repeat('x',900000),'{"driver_test":true}'::jsonb,${actorId},${actorId} FROM generate_series(1,200)`;
  let bytes=0,canonicalRows=0;
  const measured=postgres({...conn,database:dbName,transform:{row(row){bytes+=Buffer.byteLength(JSON.stringify(row));if(row.row?.body?.length>800000)canonicalRows++;return row;}}});
  try {
    const [clock]=await db`SELECT epoch,position::text FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;
    const [cursor]=await db`INSERT INTO flightdeck_pg_record_cursors(workspace_id,actor_id,epoch,state) VALUES(${workspaceId},${actorId},${clock!.epoch},${db.json({mode:'snapshot',boundary:clock!.position,after:clock!.position,family:'message',id:'',snapshotId:'70000000-0000-4000-8000-000000000001'})}) RETURNING token`;
    const p=await readFlightDeckRecordPage({workspaceId,actorId,cursor:cursor!.token},measured);
    expect(p.has_more).toBe(true);expect(canonicalRows).toBe(1);expect(bytes).toBeLessThan(1150000);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
    bytes=0;canonicalRows=0;
    await readFlightDeckRecordPage({workspaceId,actorId},measured);
    expect(canonicalRows).toBe(0);expect(bytes).toBeLessThan(150000);
  }finally{await measured.end();}
  await db`DELETE FROM flightdeck_pg_messages WHERE metadata->>'driver_test'='true'`;
  await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${workspaceId} AND permission='channel.read'`;
},30000);


test('harmless actor profile updates preserve cursors but authority rotation resets them',async()=>{
  const cursor=await synced();
  await db`UPDATE flightdeck_pg_actors SET display_name='Changed label',updated_at=now() WHERE id=${actorId}`;
  expect((await page(cursor)).next_cursor).toBe(cursor);
  await db`UPDATE flightdeck_pg_actors SET npub='npub1rotatedrecordtest' WHERE id=${actorId}`;
  await expect(page(cursor)).rejects.toMatchObject({status:409,code:'reset_required'});
  await db`UPDATE flightdeck_pg_actors SET npub='npub1recordtest' WHERE id=${actorId}`;
});

test('deep effective branches keyset huge equal-time history without full payload materialization', async () => {
  async function thread(parent: string|null = null, point: string|null = null) {
    const [t] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,parent_thread_id,branch_point_message_id,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspaceId},${scopeId},${channelId},'branch bound',${parent},${point},${actorId},${actorId}) RETURNING id`;
    return t!.id as string;
  }
  const root = await thread();
  for(let batch=1;batch<=12000;batch+=1000) await db`INSERT INTO flightdeck_pg_messages(id,workspace_id,scope_id,channel_id,thread_id,body,created_at,created_by_actor_id,updated_by_actor_id)
    SELECT ('80000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,${workspaceId},${scopeId},${channelId},${root},repeat('body',250),'2026-01-01T00:00:00.123456Z',${actorId},${actorId} FROM generate_series(${batch}::integer,${batch+999}::integer) g`;
  const anchor = '80000000-0000-4000-8000-000000011990';
  await db`UPDATE flightdeck_pg_messages SET deleted_at=now() WHERE id=${anchor}`;
  let leaf = root;
  for(let depth=0;depth<50;depth++) leaf=await thread(leaf,anchor);
  const [own] = await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_at,created_by_actor_id,updated_by_actor_id)
    VALUES(${workspaceId},${scopeId},${channelId},${leaf},'leaf','2026-01-02',${actorId},${actorId}) RETURNING id`;
  let payloadRows=0,driverBytes=0;
  const measured=postgres({...conn,database:dbName,transform:{row(row){driverBytes+=Buffer.byteLength(JSON.stringify(row));if('body' in row)payloadRows++;return row;}}});
  try {
    const input={workspaceId,channelId,threadId:leaf,limit:20,afterCreatedAt:'2026-01-01T00:00:00.123999Z',afterId:'80000000-0000-4000-8000-000000011970'};
    const first=await listEffectiveFlightDeckPgThreadMessages(input,measured);
    expect(first).toHaveLength(20);expect(first.at(-1)!.id).toBe(anchor);expect(first.at(-1)!.deleted_at).not.toBeNull();
    expect(payloadRows).toBe(20);expect(driverBytes).toBeLessThan(150000);
    const next=await listEffectiveFlightDeckPgThreadMessages({...input,afterId:anchor},measured);
    expect(next.map(m=>m.id)).toEqual([own!.id]);expect(next[0]!.inherited).toBe(false);
    payloadRows=0;
    expect((await listEffectiveFlightDeckPgThreadMessages({workspaceId,channelId,threadId:leaf,messageId:anchor,limit:1},measured))[0]!.id).toBe(anchor);
    expect(payloadRows).toBe(1);
    const invalid=await thread(leaf,'80000000-0000-4000-8000-000000012000');
    await expect(listEffectiveFlightDeckPgThreadMessages({workspaceId,channelId,threadId:invalid,limit:20},measured)).rejects.toThrow('thread_branch_point_missing');
    const earlier=await thread(leaf,'80000000-0000-4000-8000-000000000002');
    const prefix=await listEffectiveFlightDeckPgThreadMessages({workspaceId,channelId,threadId:earlier,limit:20},measured);
    expect(prefix.map(m=>m.id)).toEqual(['80000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002']);
  }finally{await measured.end();}
},30000);

});
