import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { getDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { registerRecordClient, acknowledgeRecordCheckpoint } from '../src/services/flightdeck-record-checkpoints';
import { advanceFlightDeckPgResourceActivity, markFlightDeckPgResourceViewed, resolveFlightDeckPgResourceActivity,
  listVisibleFlightDeckPgResourceViewStates, serializeFlightDeckPgTask, serializeFlightDeckPgDoc } from '../src/services/flightdeck-pg-api';

const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('personal attention in disposable Tower DB', () => {
  const database = `tower_attention_${process.pid}_${Date.now()}`;
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const authorKey = generateSecretKey(), viewerKey = generateSecretKey(), outsiderKey = generateSecretKey();
  const npub = (key: Uint8Array) => nip19.npubEncode(getPublicKey(key));
  const source = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
  const assignmentMigration = source.split('-- task_single_assignee_v1')[1]!.split('-- end_task_single_assignee_v1')[0]!;
  const previousSchema = source.split('-- task_single_assignee_v1')[0]!;
  const repaired: string[] = [];
  let ambiguousId: string, invalidId: string;
  const migrationBefore: any[] = [];
  const migrationViews: any[] = [];
  const migrationCursor: { value?: string } = {};
  const migration = source.split('-- personal_attention_v1')[1]!.split('-- end_personal_attention_v1')[0]!;
  let db: ReturnType<typeof postgres>, previous: ReturnType<typeof postgres>;
  let workspaceId: string, author: string, viewer: string, outsider: string, channel: string, scope: string;
  const app = createApp();
  beforeAll(async () => {
    const admin = postgres({ ...conn, database: 'postgres' }); await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...conn, database }); previous = getDb(); setDb(db);
    for (const stmt of splitSqlStatements(previousSchema)) await db.unsafe(stmt);
    const ids = [];
    for (const key of [authorKey, viewerKey, outsiderKey]) {
      const [a] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub(key)},'human') RETURNING id`; ids.push(a!.id);
    }
    [author, viewer, outsider] = ids;
    const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
      VALUES('attention-tower','attention-workspace',${npub(authorKey)},'attention-app','Attention') RETURNING id`; workspaceId = w!.id;
    for (const id of [author, viewer]) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspaceId},${id},'member')`;
    const [s] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspaceId},'Attention','project') RETURNING id`; scope = s!.id;
    const [c] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspaceId},${scope},'Attention') RETURNING id`; channel = c!.id;
    for (const id of [author, viewer]) for (const permission of ['channel.read','task.read','task.create','task.update','task.comment','doc.read','doc.write','channel.write'])
      await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
        VALUES(${workspaceId},'actor',${id},'channel',${channel},${permission})`;
    // Install unrelated runtime families before taking a pre-upgrade cursor.
    await ensureRuntimeSchema(db);
    await db.unsafe(`DROP TRIGGER fd_guard_single_assignment ON flightdeck_pg_task_assignments;
      DROP TRIGGER fd_sync_task_primary_assignment ON flightdeck_pg_tasks;
      DROP TRIGGER fd_normalize_task_primary ON flightdeck_pg_tasks;
      DROP INDEX IF EXISTS idx_fd_task_single_assignee; DROP VIEW flightdeck_pg_task_assignment_ambiguities`);
    // Seed the actual preceding task/assignment schema, before installing the new
    // invariant. These are the same stale shapes seen on upgraded deployments.
    for (const metadata of [{assigned_to_npub:npub(authorKey)}, {assigned_to_npub:null}, {}, {assigned_to_npub:npub(viewerKey)}, {}, {assigned_to_npub:'npub1unknown'}]) {
      const [t] = await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,metadata,activity_version,created_by_actor_id,updated_by_actor_id)
        VALUES(${workspaceId},${scope},${channel},'Historical assignment',${db.json(metadata)},7,${author},${author}) RETURNING *`;
      const id=t!.id; repaired.push(id);
      const index=repaired.length-1;
      if(index!==3&&index!==5) for(const actorId of index===2?[viewer]:[author,viewer])
        await db`INSERT INTO flightdeck_pg_task_assignments(workspace_id,scope_id,channel_id,task_id,actor_id,created_by_actor_id,updated_by_actor_id)
          VALUES(${workspaceId},${scope},${channel},${id},${actorId},${author},${author})`;
      migrationBefore.push(t);
      await read('task',id);
    }
    ambiguousId=repaired[4]!; invalidId=repaired[5]!;
    const legacyPage=await readFlightDeckRecordPage({workspaceId,actorId:viewer},db);
    migrationCursor.value=legacyPage.next_cursor;
    migrationViews.push(...await db`SELECT resource_id,viewed_activity_version,updated_at,row_version FROM flightdeck_pg_resource_view_states WHERE viewer_actor_id=${viewer} ORDER BY resource_id`);
    await db.unsafe(assignmentMigration);
  });
  afterAll(async () => { setDb(previous); await db?.end(); const admin = postgres({ ...conn, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); });
  const base = () => `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
  const mention = (id = viewer, key = viewerKey) => ({ type: 'person', actor_id: id, npub: npub(key) });
  async function request(path: string, method = 'GET', body?: unknown, key = authorKey, expectedStatus?: number) {
    const raw = body === undefined ? '' : JSON.stringify(body), tags = [['u', `http://localhost${path}`], ['method', method]];
    if (body !== undefined) tags.push(['payload', createHash('sha256').update(raw).digest('hex')]);
    const signed = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), content: '', tags }, key);
    const response = await app.request(path, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(signed)).toString('base64')}`, 'content-type':'application/json' }, ...(body === undefined ? {} : { body: raw }) });
    const result = await response.json(); if(expectedStatus) expect(response.status, JSON.stringify(result)).toBe(expectedStatus); else expect(response.status, JSON.stringify(result)).toBeLessThan(300); return result as any;
  }
  async function task() { const result = await request(`${base()}/channels/${channel}/tasks`, 'POST', { title: 'Attention task' }); return result.task.id as string; }
  async function doc(mentions: any[] = []) {
    const [storage] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,file_name,content_type,storage_path) VALUES(${npub(authorKey)},${npub(authorKey)},'doc','text/plain',${randomUUID()}) RETURNING id`;
    const [d] = await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,metadata,activity_version,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspaceId},${scope},${channel},${storage!.id},'Attention doc',${db.json({mentions})},1,${author},${author}) RETURNING *`; return d!.id as string;
  }
  async function version(kind: string, id: string, actor = viewer, workspace = workspaceId) {
    const [p] = await db`SELECT flightdeck_pg_attention_version(${workspace}::uuid,${kind},${id}::uuid,${actor}::uuid) AS version`; return Number(p!.version);
  }
  async function read(kind: 'task'|'document'|'thread', id: string, actor = viewer) {
    const resource = await resolveFlightDeckPgResourceActivity(workspaceId,kind,id,db);
    return markFlightDeckPgResourceViewed({workspaceId,actorId:actor,resource:resource!,viewedActivityVersion:Number(resource!.activity_version)},db);
  }
  async function state(kind: 'task'|'document', id: string) {
    const resource = await resolveFlightDeckPgResourceActivity(workspaceId,kind,id,db);
    const [s] = await db`SELECT viewed_activity_version FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} AND viewer_actor_id=${viewer} AND resource_type=${kind} AND resource_id=${id}`;
    return {activity:Number(resource!.activity_version),viewed:Number(s?.viewed_activity_version??0),attention:await version(kind,id)};
  }
  async function comment(kind: 'task'|'document', id: string, mentions: any[] = [], key = authorKey) {
    return request(`${base()}/${kind==='task'?'tasks':'docs'}/${id}/comments`, 'POST', { body:'Structured activity', mentions },key);
  }
  async function bodyEdit(id: string, mentions?: any[], actor = author) {
    return db.begin(async tx => {
      const sql = tx as any;
      if (mentions) await sql`UPDATE flightdeck_pg_docs SET metadata=${sql.json({mentions})},updated_by_actor_id=${actor} WHERE id=${id}`;
      return advanceFlightDeckPgResourceActivity({workspaceId,actorId:actor,resourceType:'document',resourceId:id,bodyActivity:true},sql);
    });
  }
  test('upgrades real prior task schema, journals repairs, reports ambiguity and preserves watermarks idempotently', async () => {
    const expected=[npub(authorKey),null,npub(viewerKey),npub(viewerKey)];
    for(let i=0;i<4;i++) {
      const t=(await request(`${base()}/tasks/${repaired[i]}`)).task;
      expect(t.assigned_to_npub).toBe(expected[i]);
      expect(t.assignments.map((a:any)=>a.actor_npub)).toEqual(expected[i]?[expected[i]]:[]);
      expect(t.row_version).toBe(migrationBefore[i].row_version);
      expect(t.activity_version).toBe(Number(migrationBefore[i].activity_version));
    }
    const unresolved=await db`SELECT task_id FROM flightdeck_pg_task_assignment_ambiguities ORDER BY task_id`;
    expect(unresolved.map(x=>x.task_id).sort()).toEqual([ambiguousId,invalidId].sort());
    expect((await db`SELECT * FROM flightdeck_pg_tasks WHERE id=${ambiguousId}`)[0]!.metadata).toEqual({});
    expect((await db`SELECT * FROM flightdeck_pg_tasks WHERE id=${invalidId}`)[0]!.metadata).toEqual({assigned_to_npub:'npub1unknown'});
    const delta=await readFlightDeckRecordPage({workspaceId,actorId:viewer,cursor:migrationCursor.value},db);
    expect(delta.changes.some(c=>c.family==='task_assignment'&&c.operation==='delete'&&c.id.startsWith(`${repaired[0]}:`))).toBe(true);
    expect(delta.changes.some(c=>c.family==='task'&&c.id===repaired[2])).toBe(true);
    const before=[...(await db`SELECT * FROM flightdeck_pg_tasks ORDER BY id`)];
    const assignments=[...(await db`SELECT * FROM flightdeck_pg_task_assignments ORDER BY task_id,actor_id`)];
    const clock=(await db`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`)[0];
    await db.unsafe(assignmentMigration); await db.unsafe(assignmentMigration);
    expect([...(await db`SELECT * FROM flightdeck_pg_tasks ORDER BY id`)]).toEqual(before);
    expect([...(await db`SELECT * FROM flightdeck_pg_task_assignments ORDER BY task_id,actor_id`)]).toEqual(assignments);
    expect((await db`SELECT * FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`)[0]).toEqual(clock);
    expect([...(await db`SELECT resource_id,viewed_activity_version,updated_at,row_version FROM flightdeck_pg_resource_view_states WHERE viewer_actor_id=${viewer} ORDER BY resource_id`)]).toEqual(migrationViews);
    // Resolve only with an explicit ownership decision; guard then prevents a second row.
    await request(`${base()}/tasks/${ambiguousId}`,'PATCH',{assigned_to_npub:npub(viewerKey)});
    await request(`${base()}/tasks/${invalidId}`,'PATCH',{assigned_to_npub:null});
    expect(await db`SELECT * FROM flightdeck_pg_task_assignment_ambiguities`).toHaveLength(0);
    await db.unsafe(assignmentMigration);
    const [index]=await db`SELECT indexname FROM pg_indexes WHERE indexname='idx_fd_task_single_assignee'`;
    expect(index).toBeDefined();
  });
  test('A to B, clearing, delayed delete and retries replace all representations without losing unread mentions', async () => {
    const id=await task(); await read('task',id);
    await request(`${base()}/tasks/${id}`,'PATCH',{assigned_to_npub:npub(viewerKey)});
    await comment('task',id,[mention()]); const mentionPosition=await version('task',id);
    const viewed=(await state('task',id)).viewed;
    await request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:author});
    const t=(await request(`${base()}/tasks/${id}`)).task;
    expect(t.assigned_to_npub).toBe(npub(authorKey));expect(t.assignments.map((a:any)=>a.actor_id)).toEqual([author]);
    expect(await version('task',id)).toBe(mentionPosition);expect((await state('task',id)).viewed).toBe(viewed);
    const late=await request(`${base()}/tasks/${id}/assignments/${viewer}`,'DELETE');expect(late.changed).toBe(false);
    expect((await request(`${base()}/tasks/${id}`)).task.assigned_to_npub).toBe(npub(authorKey));
    await request(`${base()}/tasks/${id}`,'PATCH',{assigned_to_npub:null});
    expect((await request(`${base()}/tasks/${id}`)).task.assignments).toHaveLength(0);
    expect(await version('task',id)).toBe(mentionPosition);
    await read('task',id); await request(`${base()}/tasks/${id}`,'PATCH',{metadata:{assigned_to_npub:npub(viewerKey)}});
    expect((await state('task',id)).attention).toBeGreaterThan((await state('task',id)).viewed);
    const activity=(await state('task',id)).activity;
    await request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:viewer});expect((await state('task',id)).activity).toBe(activity);
    await request(`${base()}/tasks/${id}/assignments/${viewer}`,'DELETE');expect(await version('task',id)).toBeLessThanOrEqual((await state('task',id)).viewed);
    expect((await request(`${base()}/tasks/${id}/assignments/${viewer}`,'DELETE')).changed).toBe(false);
  });
  test('concurrent assignments and unrelated metadata edits retain one primary; stale explicit assignment edits conflict', async () => {
    for(let i=0;i<8;i++) {
      const id=await task();
      await Promise.all([request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:viewer}),
        request(`${base()}/tasks/${id}`,'PATCH',{metadata:{tags:'concurrent'}})]);
      const t=(await request(`${base()}/tasks/${id}`)).task;
      expect(t.assigned_to_npub).toBe(npub(viewerKey));expect(t.assignments.map((a:any)=>a.actor_id)).toEqual([viewer]);expect(t.metadata.tags).toBe('concurrent');
      await Promise.all([request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:author}),request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:viewer})]);
      const current=(await request(`${base()}/tasks/${id}`)).task;
      expect(current.assignments).toHaveLength(1);expect(current.assigned_to_npub).toBe(current.assignments[0].actor_npub);
    }
  });
  test('new assignment after read, assignment idempotency, metadata helper assignment and own activity', async () => {
    const id = await task(); await read('task',id);
    await request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:viewer});
    let s = await state('task',id); expect(s.attention).toBeGreaterThan(s.viewed);
    await request(`${base()}/tasks/${id}/assignments`,'POST',{actor_id:viewer}); expect((await state('task',id)).activity).toBe(s.activity);
    await request(`${base()}/resource-view-states/task/${id}`,'PUT',{viewed_activity_version:s.activity},viewerKey);
    await request(`${base()}/tasks/${id}/assignments/${viewer}`,'DELETE'); expect(await version('task',id)).toBe(0);
    s = await state('task',id);
    await request(`${base()}/tasks/${id}`,'PATCH',{metadata:{assigned_to_npub:npub(viewerKey)}});
    expect((await state('task',id)).attention).toBeGreaterThan(s.activity);
    const before = (await state('task',id)).activity;
    await request(`${base()}/tasks/${id}`,'PATCH',{metadata:{assigned_to_npub:npub(viewerKey)}}); expect((await state('task',id)).activity).toBe(before);
    await comment('task',id,[],viewerKey); s=await state('task',id); expect(s.viewed).toBe(s.activity); expect(s.attention).toBe(0);
    await request(`${base()}/tasks/${id}`,'PATCH',{assigned_to_npub:null}); expect(await version('task',id)).toBe(0);
    await request(`${base()}/tasks/${id}`,'PATCH',{assigned_to_npubs:[npub(viewerKey)]}); expect((await state('task',id)).attention).toBeGreaterThan(s.viewed);
  });
  test('all primary input forms, multi-value rejection, membership, permissions and assignment row versions', async () => {
    const id=await task(), path=`${base()}/tasks/${id}`;
    await request(path,'PATCH',{metadata:{assigned_to_npubs:[npub(viewerKey)]}});
    const t=(await request(path)).task;expect(t.assigned_to_npub).toBe(npub(viewerKey));expect(t.assignments).toHaveLength(1);
    await request(path,'PATCH',{assigned_to_npubs:[npub(authorKey),npub(viewerKey)]},authorKey,400);
    await request(path,'PATCH',{metadata:{assigned_to_npubs:[npub(authorKey),npub(viewerKey)]}},authorKey,400);
    await request(path,'PATCH',{assigned_to_npub:npub(outsiderKey)},authorKey,400);
    await request(`${base()}/channels/${channel}/tasks`,'POST',{title:'Bad',assigned_to_npubs:[npub(authorKey),npub(viewerKey)]},authorKey,400);
    await request(path,'PATCH',{assigned_to_npub:npub(authorKey),row_version:t.row_version});
    await request(path,'PATCH',{assigned_to_npub:npub(viewerKey),row_version:t.row_version},authorKey,409);
    expect((await request(path)).task.assigned_to_npub).toBe(npub(authorKey));
    await request(`${path}/assignments`,'POST',{actor_id:viewer},outsiderKey,403);
  });
  test('task mentions retain their exact event across unrelated updates and never revive after read', async () => {
    const id=await task(); await read('task',id); await comment('task',id,[mention()]);
    const event=await version('task',id); expect(event).toBeGreaterThan(0);
    await comment('task',id); await request(`${base()}/tasks/${id}`,'PATCH',{title:'Routine title'});
    expect(await version('task',id)).toBe(event); expect((await state('task',id)).activity).toBeGreaterThan(event);
    await read('task',id); await comment('task',id); const s=await state('task',id); expect(s.attention).toBeLessThanOrEqual(s.viewed);
    await comment('task',id,[mention()]); expect((await state('task',id)).attention).toBeGreaterThan(s.viewed);
  });
  test('document body attention advances only on body activity; comments and removed body mentions', async () => {
    const id=await doc([mention()]); expect(await version('document',id)).toBe(1); await read('document',id);
    await comment('document',id); expect(await version('document',id)).toBe(1);
    await bodyEdit(id); expect((await state('document',id)).attention).toBeGreaterThan((await state('document',id)).viewed);
    await read('document',id); await comment('document',id); expect((await state('document',id)).attention).toBeLessThanOrEqual((await state('document',id)).viewed);
    await bodyEdit(id,[]); expect(await version('document',id)).toBe(0);
    await comment('document',id,[mention()]); const event=await version('document',id); await comment('document',id); expect(await version('document',id)).toBe(event);
    await bodyEdit(id,[mention()],viewer); const s=await state('document',id); expect(s.attention).toBeLessThanOrEqual(s.viewed);
  });
  test('removed/deleted structured comments cancel only their own mention positions; fake tags and foreign IDs are neutral', async () => {
    const id=await task(), first=await comment('task',id,[mention()]), second=await comment('task',id,[mention()]);
    const latest=await version('task',id);
    await db`UPDATE flightdeck_pg_task_comments SET metadata='{}'::jsonb WHERE id=${second.comment.id}`;
    const prior=await version('task',id); expect(prior).toBeGreaterThan(0); expect(prior).toBeLessThan(latest);
    await db`UPDATE flightdeck_pg_task_comments SET deleted_at=now() WHERE id=${first.comment.id}`; expect(await version('task',id)).toBe(0);
    const docId=await doc(), tagged=await comment('document',docId,[mention()]);
    await request(`${base()}/docs/${docId}/comments/${tagged.comment.id}`,'DELETE'); expect(await version('document',docId)).toBe(0);
    await db`UPDATE flightdeck_pg_docs SET metadata=${db.json({mentions:[{...mention(),actor_id:outsider}]})} WHERE id=${docId}`;
    await bodyEdit(docId); expect(await version('document',docId)).toBe(0); expect(await version('document',docId,outsider)).toBe(0);
    await request(`${base()}/tasks/${id}/comments`,'POST',{body:`@[Viewer](mention:person:${npub(viewerKey)})`,mentions:[]}); expect(await version('task',id)).toBe(0);
  });
  test('legacy view-state baseline preserves existing read state; v1/v2 delivery and ack never mark read', async () => {
    await listVisibleFlightDeckPgResourceViewStates({workspaceId,actorId:viewer,groupIds:[],limit:500},db);
    const id=await task(); await read('task',id); await comment('task',id,[mention()]);
    const before=await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} AND viewer_actor_id=${viewer}`;
    const states=await request(`${base()}/resource-view-states`,'GET',undefined,viewerKey);
    const s=states.states.find((x:any)=>x.resource_type==='task'&&x.resource_id===id); expect(s.attention_policy_version).toBe(1); expect(s.attention_unread).toBe(true); expect(s.unread).toBe(true);
    const clientId=randomUUID(), registration=await registerRecordClient({workspaceId,actorId:viewer,clientId},db);
    for (const protocol of [1,2] as const) {
      let cursor:string|undefined=protocol===2?registration.initial_cursor:undefined; const changes:any[]=[];
      for(let i=0;i<100;i++) {
        const p=protocol===1?await readFlightDeckRecordPage({workspaceId,actorId:viewer,cursor},db):await readFlightDeckRecordPage({workspaceId,actorId:viewer,protocolVersion:2,clientId,cursor:cursor!},db);
        changes.push(...p.changes); cursor=p.next_cursor; if(!p.has_more) break;
      }
      const raw=changes.find(c=>c.family==='task'&&c.id===id); expect(raw.row.attention.mention_activity_versions[viewer]).toBe(s.attention_activity_version);
      const view=changes.find(c=>c.family==='resource_view_state'&&c.row.resource_id===id&&c.row.viewer_actor_id===viewer); expect(view.row.attention_unread).toBe(true); expect(view.row.activity_version).toBe(s.activity_version);
      expect(changes.some(c=>c.family==='resource_view_state'&&c.row.viewer_actor_id!==viewer)).toBe(false);
      if(protocol===2) await acknowledgeRecordCheckpoint({workspaceId,actorId:viewer,clientId,cursor:cursor!,expectedRevision:registration.checkpoint_revision},db);
    }
    expect([...(await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} AND viewer_actor_id=${viewer}`)]).toEqual([...before]);
    const [taskRow]=await db`SELECT * FROM flightdeck_pg_tasks WHERE id=${id}`; expect(serializeFlightDeckPgTask(taskRow as any).attention).toEqual(taskRow!.attention);
    const docId=await doc([mention()]), [docRow]=await db`SELECT * FROM flightdeck_pg_docs WHERE id=${docId}`; expect(serializeFlightDeckPgDoc(docRow as any).attention).toEqual(docRow!.attention);
    const outsiderPage=readFlightDeckRecordPage({workspaceId,actorId:outsider},db); await expect(outsiderPage).rejects.toMatchObject({status:403});
    expect(await version('task',id,viewer,randomUUID())).toBe(0);
  });
  test('v2 historical view-state retry is pinned when attention changes after delivery', async () => {
    const id=await task(); await read('task',id);
    const clientId=randomUUID(), registration=await registerRecordClient({workspaceId,actorId:viewer,clientId},db);
    const page=(cursor:string,limit=200)=>readFlightDeckRecordPage({workspaceId,actorId:viewer,protocolVersion:2,clientId,cursor,limit},db);
    let p=await page(registration.initial_cursor); while(p.has_more) p=await page(p.next_cursor);
    const tagged=await comment('task',id,[mention()]);
    let input=p.next_cursor, pinned:any;
    for(let i=0;i<30;i++) {
      const delivered=await page(input,1);
      if(delivered.changes.some(c=>c.family==='resource_view_state'&&c.row?.resource_id===id&&c.row.attention_unread===true)) {pinned=delivered;break;}
      input=delivered.next_cursor;
    }
    expect(pinned).toBeDefined();
    const [before]=await db`SELECT viewed_activity_version,updated_at FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} AND viewer_actor_id=${viewer} AND resource_id=${id}`;
    await comment('task',id);
    await db`UPDATE flightdeck_pg_task_comments SET deleted_at=now() WHERE id=${tagged.comment.id}`;
    const replay=await page(input,1); expect(replay.changes).toEqual(pinned.changes);
    await acknowledgeRecordCheckpoint({workspaceId,actorId:viewer,clientId,cursor:pinned.next_cursor,expectedRevision:registration.checkpoint_revision},db);
    const [current]=await db`SELECT viewed_activity_version,updated_at,attention_unread FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} AND viewer_actor_id=${viewer} AND resource_id=${id}`;
    expect(current!.viewed_activity_version).toBe(before!.viewed_activity_version);expect(current!.updated_at).toEqual(before!.updated_at);expect(current!.attention_unread).toBe(false);
  });
  test('existing-row backfill uses exact surviving history, updates canonical cache and is idempotent without watermark/checkpoint changes', async () => {
    const id=await task(); await comment('task',id,[mention()]); const position=await version('task',id); await read('task',id); await comment('task',id);
    const before=await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} ORDER BY viewer_actor_id,resource_type,resource_id`;
    await db`ALTER TABLE flightdeck_pg_tasks ALTER COLUMN attention DROP NOT NULL`;
    await db`UPDATE flightdeck_pg_tasks SET attention=NULL WHERE id=${id}`;
    await db.unsafe(migration); expect(await version('task',id)).toBe(position);
    const [current]=await db`SELECT row FROM flightdeck_pg_record_current WHERE workspace_id=${workspaceId} AND family='task' AND id=${id}`;
    expect(current!.row.attention.mention_activity_versions[viewer]).toBe(position);
    const [clock]=await db`SELECT position,epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`;
    await ensureRuntimeSchema(db); await ensureRuntimeSchema(db);
    expect((await db`SELECT position,epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${workspaceId}`)[0]).toEqual(clock);
    expect([...(await db`SELECT * FROM flightdeck_pg_resource_view_states WHERE workspace_id=${workspaceId} ORDER BY viewer_actor_id,resource_type,resource_id`)]).toEqual([...before]);
  });
});
