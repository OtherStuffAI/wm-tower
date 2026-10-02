import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { runContextTree, ContextTreeError, normalizeContextTarget, type ContextTreeActor } from '../src/services/flightdeck-pg-context-tree';
import { runScopeAccess } from '../src/services/flightdeck-pg-scope-access';
import { authorizeFlightDeckPgOperation } from '../src/services/flightdeck-pg-authorization';
import { acquireFlightDeckPgEditLease, listVisibleFlightDeckPgScopes, listVisibleFlightDeckPgChannels, listVisibleFlightDeckPgEvents, serializeFlightDeckPgEvent } from '../src/services/flightdeck-pg-api';
import { getEffectiveFlightDeckPgGroupIds } from '../src/services/flightdeck-pg-authorization';
import { readFlightDeckRecordPage } from '../src/services/flightdeck-record-delta';
import { createApp } from '../src/server';

// Explicit opt-in to an existing disposable PG fixture; never connect to runtime/production.
const port = Number(process.env.CONTEXT_TEST_PORT);
describe.skipIf(!port || port === 5432)('Context Tree v1 disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const database = `tower_context_tree_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>, manager: ContextTreeActor, reader: ContextTreeActor, channelReader: ContextTreeActor, outsider: ContextTreeActor;
  let actorId: string, readerId: string, outsiderId: string, scopeId: string, scope2: string, channelId: string, privateChannel: string, taskId: string, privateTaskId: string, docId: string, fileId: string;
  const managerKey = new Uint8Array(32).fill(61), readerKey = new Uint8Array(32).fill(62);
  const npub = (n: number) => nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(n)));
  const app = createApp();
  beforeAll(async () => {
    const admin = postgres({ ...conn, database: 'postgres' });
    await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...conn, database }); setDb(db);
    for (const stmt of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(stmt);
    const actors = [];
    for (let n = 61; n <= 64; n++) {
      const [a] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub(n)},'human') RETURNING id`; actors.push(a!.id);
    }
    [actorId, readerId, , outsiderId] = actors;
    const [w] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
      VALUES('tower-context','workspace-context',${npub(61)},'context-app','Context Test') RETURNING id`;
    for (const id of actors) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w!.id},${id},'member')`;
    const [s] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w!.id},'Software','project') RETURNING id`; scopeId = s!.id;
    const [s2] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w!.id},'Operations','project') RETURNING id`; scope2 = s2!.id;
    const [c] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w!.id},${scopeId},'Public') RETURNING id`; channelId = c!.id;
    const [c2] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w!.id},${scope2},'Private') RETURNING id`; privateChannel = c2!.id;
    for (const id of [actorId, readerId]) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission)
      VALUES(${w!.id},'actor',${id},'scope',${scopeId},'scope.read')`;
    for (const scope of [scopeId, scope2]) for (const permission of ['scope.read','scope.manage']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_scope_id,permission)
      VALUES(${w!.id},'actor',${actorId},'scope',${scope},${permission}) ON CONFLICT DO NOTHING`;
    for (const id of [actorId, readerId, actors[2]]) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${w!.id},'actor',${id},'channel',${channelId},'channel.read')`;
    for (const id of [actorId, readerId]) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${w!.id},'actor',${id},'channel',${channelId},'task.read')`;
    for (const permission of ['channel.read','task.read']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission)
      VALUES(${w!.id},'actor',${actorId},'channel',${privateChannel},${permission})`;
    manager = { workspaceId: w!.id, scopeId, actorNpub: npub(61), appNpub: 'context-app' };
    reader = { ...manager, actorNpub: npub(62) }; channelReader = { ...manager, actorNpub: npub(63) }; outsider = { ...manager, actorNpub: npub(64) };
    const task = async (scope: string, channel: string, title: string) => {
      const [r] = await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id)
        VALUES(${w!.id},${scope},${channel},${title},${actorId},${actorId}) RETURNING id`; return r!.id;
    };
    taskId = await task(scopeId, channelId, 'Shared task'); privateTaskId = await task(scope2, privateChannel, 'Private title must not leak');
    for (const kind of ['doc','file']) {
      const [storage] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,sha256_hex,size_bytes,content_type,storage_path) VALUES(${npub(61)},${npub(61)},${createHash('sha256').update(kind).digest('hex')},0,'text/plain',${kind}) RETURNING id`;
      const table = kind === 'doc' ? 'flightdeck_pg_docs' : 'flightdeck_pg_files';
      const data = { workspace_id:w!.id, scope_id:scopeId, channel_id:channelId, storage_object_id:storage!.id, created_by_actor_id:actorId, updated_by_actor_id:actorId, [kind === 'doc' ? 'title' : 'display_name']: `Shared ${kind}` };
      const [r] = await db`INSERT INTO ${db(table)} ${db(data)} RETURNING id`;
      if (kind === 'doc') docId=r!.id; else fileId=r!.id;
    }
  });
  afterAll(async () => {
    await closeDb();
    const admin = postgres({ ...conn, database: 'postgres' });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });
  async function create(title: string, parent_id: string | null = null, actor = manager) {
    return (await runContextTree(actor, 'create', { body: { title, parent_id } }, db)).component;
  }
  async function update(row: any, patch: object) {
    return (await runContextTree(manager, 'update', { componentId: row.id, body: { expected_row_version: row.row_version, ...patch } }, db)).component;
  }
  async function preview(id: string) { return (await runContextTree(manager,'preview',{componentId:id},db)).preview; }
  async function remove(id: string, token: string) { return runContextTree(manager,'delete',{componentId:id,body:{confirmation_token:token}},db); }
  async function attach(id: string, type: string, target: object) { return (await runContextTree(manager,'attach',{componentId:id,body:{target_type:type,target}},db)).reference; }
  async function code(action: Promise<unknown>, expected: string) {
    try { await action; throw new Error('Expected failure'); } catch (e) { expect(e).toBeInstanceOf(ContextTreeError); expect((e as ContextTreeError).code).toBe(expected); }
  }
  function request(path: string, method = 'GET', body?: object, key = managerKey) {
    const url = `http://localhost/api/v4/flightdeck-pg/workspaces/${manager.workspaceId}/scopes/${scopeId}/context/components${path}`;
    const tags = [['u',url],['method',method]];
    if (body) tags.push(['payload',createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
    const auth = finalizeEvent({ kind:27235, created_at:Math.floor(Date.now()/1000), content:'', tags },key);
    return app.request(url,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  }
  test('bootstrap/runtime schema is identical, additive and idempotent', async () => {
    const bootstrap = readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8').split('-- context_tree_v1\n')[1]!.split('-- end_context_tree_v1')[0]!.trim();
    expect(bootstrap).toBe(readFileSync(new URL('../src/schema/context-tree-v1.sql',import.meta.url),'utf8').trim());
    await db`DROP TABLE flightdeck_pg_context_references`; await db`DROP TABLE flightdeck_pg_context_components`;
    await ensureRuntimeSchema(db); await ensureRuntimeSchema(db);
    expect((await db`SELECT tablename FROM pg_tables WHERE tablename LIKE 'flightdeck_pg_context_%'`).length).toBe(2);
  },30000);
  test('WP2 capture bootstrap matches runtime SQL and installation preserves epoch on repeat', async () => {
    const sync=readFileSync(new URL('../src/schema/context-tree-sync-v1.sql',import.meta.url),'utf8');
    const bootstrap=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8');
    expect(bootstrap).toContain(sync);
    const before=(await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${manager.workspaceId}`)[0]!.epoch;
    await db.unsafe(sync);
    expect((await db`SELECT epoch FROM flightdeck_pg_record_clock WHERE workspace_id=${manager.workspaceId}`)[0]!.epoch).toBe(before);
  });
  test('multiple roots/children persist; moving only root preserves subtree/reference and appends siblings', async () => {
    const a=await create('A'), b=await create('B'), child=await create('Child',a.id), grandchild=await create('Grandchild',child.id), sibling=await create('Sibling',b.id);
    const link=await attach(child.id,'task',{record_id:taskId});
    const moved=await update(child,{parent_id:b.id}); expect(moved.sort_order).toBe(sibling.sort_order+1);
    const fresh=postgres({...conn,database});
    const rows=await fresh`SELECT * FROM flightdeck_pg_context_components WHERE workspace_id=${manager.workspaceId} AND scope_id=${scopeId} AND id IN ${fresh([a.id,b.id,child.id,grandchild.id])} ORDER BY id`;
    expect(rows.length).toBe(4);expect(rows.find(r=>r.id===grandchild.id)!.parent_id).toBe(child.id);expect(rows.find(r=>r.id===grandchild.id)!.row_version).toBe(1);
    expect((await fresh`SELECT * FROM flightdeck_pg_context_references WHERE id=${link.id}`)[0]!.deleted_at).toBeNull(); await fresh.end();
    await remove(a.id,(await preview(a.id)).confirmation_token);
    expect((await runContextTree(manager,'references',{componentId:child.id},db)).references.length).toBe(1);
  });
  test('stale updates, self/descendant parent, cross-scope and cross-workspace rejected', async () => {
    const a=await create('Cycle'),b=await create('Child',a.id);
    await code(update(a,{parent_id:a.id}),'circular_parent');await code(update(a,{parent_id:b.id}),'circular_parent');
    const changed=await update(a,{title:'Renamed'});await code(update(a,{title:'Stale'}),'row_version_conflict');expect(changed.row_version).toBe(2);
    const other=await create('Other',null,{...manager,scopeId:scope2});await code(update(changed,{parent_id:other.id}),'context_not_found');
    await code(runContextTree({...manager,workspaceId:randomUUID()},'update',{componentId:a.id,body:{expected_row_version:2,title:'Wrong workspace'}},db),'context_not_found');
  });
  test('concurrent opposing moves serialize: exactly one succeeds, no cycle', async () => {
    const a=await create('Opposite A'),b=await create('Opposite B');
    const results=await Promise.allSettled([update(a,{parent_id:b.id}),update(b,{parent_id:a.id})]);
    expect(results.filter(r=>r.status==='fulfilled').length).toBe(1);
    expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('circular_parent');
    const rows=await db`SELECT id,parent_id FROM flightdeck_pg_context_components WHERE id IN ${db([a.id,b.id])}`;
    expect(rows.filter(r=>r.parent_id===null).length).toBe(1);
  });
  test('preview invalidates after rename/reorder/move and same-count link replacement', async () => {
    let a=await create('Preview A'),b=await create('Preview B'),child=await create('Preview Child',a.id);
    const p=await preview(a.id); child=await update(child,{title:'Changed'}); await code(remove(a.id,p.confirmation_token),'delete_preview_changed');
    const p2=await preview(a.id);child=await update(child,{sort_order:25});await code(remove(a.id,p2.confirmation_token),'delete_preview_changed');
    const p3=await preview(a.id);child=await update(child,{parent_id:b.id});await code(remove(a.id,p3.confirmation_token),'delete_preview_changed');
    const link=await attach(a.id,'task',{record_id:taskId});const p4=await preview(a.id);
    await runContextTree(manager,'unlink',{componentId:a.id,referenceId:link.id,body:{expected_row_version:1}},db);
    await attach(a.id,'task',{record_id:privateTaskId});expect((await preview(a.id)).reference_count).toBe(p4.reference_count);
    await code(remove(a.id,p4.confirmation_token),'delete_preview_changed');
  });
  test('confirmed subtree tombstones, audit/outbox atomic and targets unchanged', async () => {
    const root=await create('Delete'),child=await create('Delete Child',root.id),grand=await create('Delete Grandchild',child.id);
    await attach(root.id,'task',{record_id:taskId});await attach(child.id,'doc',{record_id:docId});await attach(grand.id,'file',{record_id:fileId});
    const beforeTargets=await db`SELECT to_jsonb(t) AS row FROM flightdeck_pg_tasks t WHERE id=${taskId} UNION ALL SELECT to_jsonb(d) FROM flightdeck_pg_docs d WHERE id=${docId} UNION ALL SELECT to_jsonb(f) FROM flightdeck_pg_files f WHERE id=${fileId}`;
    const p=await preview(root.id);expect(p.component_count).toBe(3);expect(p.reference_count).toBe(3);
    const result=await remove(root.id,p.confirmation_token);expect(result.outbox.length).toBe(6);
    expect((await db`SELECT id FROM flightdeck_pg_context_components WHERE id IN ${db([root.id,child.id,grand.id])} AND deleted_at IS NULL`).length).toBe(0);
    const afterTargets=await db`SELECT to_jsonb(t) AS row FROM flightdeck_pg_tasks t WHERE id=${taskId} UNION ALL SELECT to_jsonb(d) FROM flightdeck_pg_docs d WHERE id=${docId} UNION ALL SELECT to_jsonb(f) FROM flightdeck_pg_files f WHERE id=${fileId}`;
    expect(afterTargets).toEqual(beforeTargets);
    const events=await db`SELECT * FROM flightdeck_pg_outbox_events WHERE payload->>'mutation_id'=${result.mutation_id}`;
    expect(events.length).toBe(6);expect(events.every(e=>e.operation==='deleted' && Number(e.entity_row_version)===2 && !JSON.stringify(e.payload).includes('record_id'))).toBe(true);
    expect((await db`SELECT * FROM flightdeck_pg_audit_events WHERE id=${result.audit.event_id}`).length).toBe(1);
  });
  test('failure writing audit rolls back structure, references and outbox', async () => {
    const a=await create('Rollback');await attach(a.id,'task',{record_id:taskId});const p=await preview(a.id);
    const beforeEvents=Number((await db`SELECT COUNT(*) AS n FROM flightdeck_pg_outbox_events`)[0]!.n);
    await db.unsafe(`CREATE FUNCTION context_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='context.delete' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
    await db.unsafe(`CREATE TRIGGER context_fail BEFORE INSERT ON flightdeck_pg_audit_events FOR EACH ROW EXECUTE FUNCTION context_fail_audit()`);
    try {await expect(remove(a.id,p.confirmation_token)).rejects.toThrow('test audit failure');} finally {await db.unsafe('DROP TRIGGER context_fail ON flightdeck_pg_audit_events');}
    expect((await preview(a.id)).confirmation_token).toBe(p.confirmation_token);
    expect(Number((await db`SELECT COUNT(*) AS n FROM flightdeck_pg_outbox_events`)[0]!.n)).toBe(beforeEvents);
  });
  test('delete queued behind mutation rechecks exact subtree under the scope lock', async () => {
    const root=await create('Race Root'),child=await create('Race Child',root.id);
    const p=await preview(root.id);
    let locked!:()=>void, release!:()=>void;
    const acquired=new Promise<void>(resolve=>{locked=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const mutation=db.begin(async transaction=>{
      const tx=transaction as unknown as typeof db;
      await tx`SELECT id FROM flightdeck_pg_scopes WHERE id=${scopeId} FOR UPDATE`;
      await tx`UPDATE flightdeck_pg_context_components SET title='Concurrent rename',row_version=row_version+1,updated_at=NOW() WHERE id=${child.id}`;
      locked();await gate;
    });
    await acquired;
    const deletion=remove(root.id,p.confirmation_token);
    release();await mutation;
    await code(deletion,'delete_preview_changed');
    expect((await preview(root.id)).component_count).toBe(2);
  });
  test('schema rejects cross-workspace/scope parents and invalid row versions', async () => {
    const root=await create('FK Root');
    const other=await create('FK Other',null,{...manager,scopeId:scope2});
    const bad=async(values:object)=>db`INSERT INTO flightdeck_pg_context_components ${db({workspace_id:manager.workspaceId,scope_id:scopeId,title:'Bad',sort_order:0,...values})}`;
    await expect(bad({parent_id:other.id})).rejects.toMatchObject({code:'23503'});
    await expect(bad({workspace_id:randomUUID(),parent_id:root.id})).rejects.toMatchObject({code:'23503'});
    await expect(bad({row_version:0})).rejects.toMatchObject({code:'23514'});
    await expect(bad({sort_order:-1})).rejects.toMatchObject({code:'23514'});
  });
  test('scope readers/channel-only readers can read; no mutation or preview; denied scope hidden', async () => {
    expect((await runContextTree(reader,'list',{},db)).capabilities).toMatchObject({read:true,manage:false,edit:false,scope_manage:false});
    expect((await runContextTree(channelReader,'list',{},db)).capabilities.read).toBe(true);
    const a=await create('Permissions');
    for(const operation of ['create','update','attach','unlink','delete','preview'] as const) await code(runContextTree(reader,operation,{componentId:a.id,referenceId:operation==='unlink'?randomUUID():undefined,body:{}},db),'permission_denied');
    await code(runContextTree(outsider,'list',{},db),'context_not_found');
  });
  test('targets in other scopes allowed under target ACL; revoked/missing targets neutral; dedup isolated to component', async () => {
    const a=await create('References'),b=await create('References B');
    await attach(a.id,'task',{record_id:privateTaskId});await attach(b.id,'task',{record_id:privateTaskId});
    await code(attach(a.id,'task',{record_id:privateTaskId}),'duplicate_reference');
    const list=await runContextTree(reader,'references',{componentId:a.id},db);
    expect(list.references[0].resolution).toEqual({status:'unavailable'});
    expect(JSON.stringify(list)).not.toContain('Private title');
    await code(runContextTree({...manager,actorNpub:reader.actorNpub},'attach',{componentId:a.id,body:{target_type:'task',target:{record_id:privateTaskId}}},db),'permission_denied');
    await code(attach(a.id,'task',{record_id:randomUUID()}),'target_unavailable');
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE workspace_id=${manager.workspaceId} AND principal_actor_id=${actorId} AND resource_channel_id=${privateChannel} AND permission='task.read'`;
    await code(attach(a.id,'task',{record_id:privateTaskId}),'target_unavailable');
    expect((await runContextTree(manager,'references',{componentId:b.id},db)).references[0]!.resolution).toEqual({status:'unavailable'});
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE workspace_id=${manager.workspaceId} AND principal_actor_id=${actorId} AND resource_channel_id=${privateChannel} AND permission='task.read'`;
    const link=await attach(a.id,'doc',{record_id:docId});
    expect(link.resolution!.status).toBe('available'); // channel.read fallback, no doc.read grant
    await db`UPDATE flightdeck_pg_docs SET deleted_at=NOW() WHERE id=${docId}`;
    expect((await runContextTree(reader,'references',{componentId:a.id},db)).references.find((r:any)=>r.id===link.id)!.resolution).toEqual({status:'unavailable'});
    await db`UPDATE flightdeck_pg_docs SET deleted_at=NULL WHERE id=${docId}`;
  });
  test('artifact canonicalization rejects unsafe schemes/path and deduplicates canonical origin', async () => {
    const a=await create('Artifact');
    const target={origin:'https://EXAMPLE.com:443/',project:'Suite',artifact:'Board',page:'index.html',version_policy:'latest'};
    const link=await attach(a.id,'artifact',target);expect((link.target as {origin:string}).origin).toBe('https://example.com');expect(link.resolution).toEqual({status:'external'});
    await code(attach(a.id,'artifact',{...target,origin:'https://example.com'}),'duplicate_reference');
    for(const origin of ['javascript:alert(1)',['https://', 'user:pass@', 'example.com'].join(''),'https://example.com/path','https://example.com?x=1','data:text/html,hi']) expect(()=>normalizeContextTarget('artifact',{...target,origin})).toThrow();
    for(const project of ['..','a/b','a%2Fb']) expect(()=>normalizeContextTarget('artifact',{...target,project})).toThrow();
  });
  test('bounded paging with route-bound cursors; malformed/unknown input rejected', async () => {
    const ids:string[]=[];let cursor: string|undefined;
    do {const p=await runContextTree(manager,'list',{limit:3,cursor},db);ids.push(...p.components.map((r:any)=>r.id));cursor=p.next_cursor??undefined;} while(cursor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(Number((await db`SELECT COUNT(*) AS n FROM flightdeck_pg_context_components WHERE scope_id=${scopeId} AND deleted_at IS NULL`)[0]!.n));
    const first=await runContextTree(manager,'list',{limit:1},db);
    await code(runContextTree({...manager,scopeId:scope2},'list',{cursor:first.next_cursor},db),'validation_error');
    await code(runContextTree(manager,'list',{limit:201},db),'validation_error');await code(runContextTree(manager,'create',{body:{title:'x',body:'unsupported'}},db),'validation_error');
  });
  test('outbox scoped independently of workspace subscription; safe refetch shapes', async () => {
    const groupIds=await getEffectiveFlightDeckPgGroupIds(manager.workspaceId,readerId,db);
    const visible=await listVisibleFlightDeckPgEvents({workspaceId:manager.workspaceId,actorId:readerId,groupIds,afterRowVersion:0,limit:1000,includeWorkspaceEvents:true},db);
    const context=visible.filter(e=>e.entity_type.startsWith('context_'));expect(context.length).toBeGreaterThan(0);
    expect(context.every(e=>e.scope_id===scopeId)).toBe(true);
    expect(serializeFlightDeckPgEvent(context[0]!).refetch.route).toContain('/context/components');
    const hidden=await listVisibleFlightDeckPgEvents({workspaceId:manager.workspaceId,actorId:outsiderId,groupIds:[],afterRowVersion:0,limit:1000,includeWorkspaceEvents:true},db);
    expect(hidden.filter(e=>e.entity_type.startsWith('context_')).length).toBe(0);
  });
  test('signed routes use identity/error envelopes and reject bypassed controls', async () => {
    const created=await request('','POST',{title:'API Root'});expect(created.status).toBe(201);const payload=await created.json();expect(payload.identity.workspace_id).toBe(manager.workspaceId);
    const a=payload.component;
    const linkResponse=await request(`/${a.id}/references`,'POST',{target_type:'task',target:{record_id:taskId}});expect(linkResponse.status).toBe(201);
    const link=(await linkResponse.json()).reference;
    const refs=await (await request(`/${a.id}/references`)).json();expect(refs.references.length).toBe(1);
    expect((await request(`/${a.id}/references/${link.id}`,'DELETE',{expected_row_version:2})).status).toBe(409);
    expect((await request(`/${a.id}/references/${link.id}`,'DELETE',{expected_row_version:1},readerKey)).status).toBe(403);
    expect((await request(`/${a.id}/references/${link.id}`,'DELETE',{expected_row_version:1})).status).toBe(200);
    const denied=await request(`/${a.id}`,'PATCH',{title:'Denied',expected_row_version:1},readerKey);expect(denied.status).toBe(403);expect((await denied.json()).code).toBe('permission_denied');
    const changed=await request(`/${a.id}`,'PATCH',{title:'API Renamed',expected_row_version:1});expect(changed.status).toBe(200);
    expect((await request(`/${a.id}`,'PATCH',{title:'Stale',expected_row_version:1})).status).toBe(409);
    const p=await (await request(`/${a.id}/delete-preview`)).json();expect(p.preview.component_count).toBe(1);
    expect((await request(`/${a.id}/delete`,'POST',{confirmation_token:p.preview.confirmation_token})).status).toBe(200);
    expect((await request('?limit=bad')).status).toBe(400);
  });
  test('existing hard scope/workspace cleanup is not blocked by context foreign keys', async () => {
    const [w]=await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower-cleanup','workspace-cleanup','owner-cleanup','app-cleanup','Cleanup') RETURNING id`;
    const [scope]=await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w!.id},'Cleanup','project') RETURNING id`;
    const [root]=await db`INSERT INTO flightdeck_pg_context_components(workspace_id,scope_id,title,sort_order) VALUES(${w!.id},${scope!.id},'Root',0) RETURNING id`;
    const [child]=await db`INSERT INTO flightdeck_pg_context_components(workspace_id,scope_id,title,parent_id,sort_order) VALUES(${w!.id},${scope!.id},'Child',${root!.id},0) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_context_references(workspace_id,scope_id,component_id,target_type,target,sort_order) VALUES(${w!.id},${scope!.id},${child!.id},'task',${db.json({record_id:taskId})},0)`;
    const source=await create('Cross workspace source');
    await code(update(source,{parent_id:child!.id}),'context_not_found');
    const invalidParent=async()=>{await db`UPDATE flightdeck_pg_context_components SET parent_id=${child!.id} WHERE id=${source.id}`;};
    await expect(invalidParent()).rejects.toMatchObject({code:'23503'});
    const rollback=new Error('rollback test workspace deletion');
    const deletion=db.begin(async transaction=>{
      const tx=transaction as unknown as typeof db;
      await tx`DELETE FROM flightdeck_pg_scopes WHERE id=${scope!.id}`;
      await tx`DELETE FROM flightdeck_pg_workspaces WHERE id=${w!.id}`;
      expect((await tx`SELECT id FROM flightdeck_pg_context_components WHERE workspace_id=${w!.id}`).length).toBe(0);
      expect((await tx`SELECT id FROM flightdeck_pg_context_references WHERE workspace_id=${w!.id}`).length).toBe(0);
      throw rollback;
    });
    await expect(deletion).rejects.toBe(rollback);
  });
  test('WP2 paged snapshot/delta captures links and coherent subtree tombstones without target metadata', async () => {
    const root=await create('Sync root'), child=await create('Sync child',root.id);
    const link=await attach(child.id,'task',{record_id:privateTaskId});
    async function catchup(actor=readerId,cursor?:string) {
      const changes:any[]=[];let p;
      do { p=await readFlightDeckRecordPage({workspaceId:manager.workspaceId,actorId:actor,cursor,limit:2},db); changes.push(...p.changes);cursor=p.next_cursor; } while(p.has_more);
      return {changes,cursor};
    }
    const initial=await catchup();
    const synced=initial.changes.filter(c=>c.family.startsWith('context_'));
    expect(synced.find(c=>c.id===root.id)?.row.title).toBe('Sync root');
    expect(synced.find(c=>c.id===link.id)?.row.target).toEqual({record_id:privateTaskId});
    expect(synced.every(c=>!c.row?.resolution)).toBe(true);
    expect(JSON.stringify(synced)).not.toContain('Private title');
    expect((await catchup(outsiderId)).changes.filter(c=>c.family.startsWith('context_'))).toEqual([]);
    await update(child,{title:'Second client'});
    const changed=await catchup(readerId,initial.cursor);
    expect(changed.changes.find(c=>c.id===child.id)?.row.title).toBe('Second client');
    await remove(root.id,(await preview(root.id)).confirmation_token);
    const removed=await catchup(readerId,changed.cursor);
    expect(removed.changes.filter(c=>[root.id,child.id,link.id].includes(c.id))).toHaveLength(3);
    expect(removed.changes.every(c=>c.operation==='delete'&&c.row===null)).toBe(true);
    expect((await db`SELECT title FROM flightdeck_pg_tasks WHERE id=${privateTaskId}`)[0]!.title).toBe('Private title must not leak');
    const fresh=await catchup(); expect(fresh.changes.some(c=>[root.id,child.id,link.id].includes(c.id))).toBe(false);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NOW() WHERE principal_actor_id=${readerId} AND workspace_id=${manager.workspaceId}`;
    await expect(readFlightDeckRecordPage({workspaceId:manager.workspaceId,actorId:readerId,cursor:removed.cursor},db)).rejects.toMatchObject({code:'reset_required'});
    expect((await catchup()).changes.filter(c=>c.family.startsWith('context_'))).toEqual([]);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=NULL WHERE principal_actor_id=${readerId} AND workspace_id=${manager.workspaceId}`;
  });
  test('context.edit direct agent grant, exact scope/workspace, reader denial, target ACL and immediate revocation', async () => {
    await db`UPDATE flightdeck_pg_actors SET kind='agent',display_name='Fixture context agent' WHERE id=${outsiderId}`;
    await db`INSERT INTO user_profiles(user_npub,display_name) VALUES(${outsider.actorNpub},'Mirrored fixture name') ON CONFLICT(user_npub) DO UPDATE SET display_name=EXCLUDED.display_name`;
    const named=await runScopeAccess(manager,undefined,db);
    expect(named.principals.actors.find(a=>a.id===outsiderId)?.label).toBe('Fixture context agent');
    expect(named.principals.actors.find(a=>a.id===outsiderId)?.npub).toBe(outsider.actorNpub);
    await db`UPDATE flightdeck_pg_actors SET display_name=NULL WHERE id=${outsiderId}`;
    const mirrored=await runScopeAccess(manager,undefined,db);
    expect(mirrored.principals.actors.find(a=>a.id===outsiderId)?.label).toBe('Mirrored fixture name');
    await db`UPDATE flightdeck_pg_actors SET display_name='Fixture context agent' WHERE id=${outsiderId}`;
    await db`DELETE FROM user_profiles WHERE user_npub=${outsider.actorNpub}`;
    const current=await runScopeAccess(manager,undefined,db);
    const lease=await acquireFlightDeckPgEditLease({workspaceId:manager.workspaceId,entityType:'scope',entityId:scopeId,actorId,actorNpub:manager.actorNpub},db);
    expect(current.principals.actors.some(a=>a.id===outsiderId && a.kind==='agent')).toBe(true);
    expect(lease.ok).toBe(true); if(!lease.ok) throw Error('lease');
    const saved=await runScopeAccess(manager,{principal_type:'actor',principal_id:outsiderId,role:'context_editor',expected_revision:current.revision,lease_token:lease.lease.lease_token},db);
    expect(saved.effective_access.find(e=>e.actor_id===outsiderId)?.sources[0]?.via).toBe('Direct');
    const context=await runContextTree(outsider,'list',{},db);expect(context.capabilities).toMatchObject({read:true,edit:true,manage:true,scope_manage:false});
    expect((await listVisibleFlightDeckPgScopes({workspaceId:manager.workspaceId,actorId:outsiderId,groupIds:[],limit:200},db)).map(s=>s.id)).toContain(scopeId);
    expect(await listVisibleFlightDeckPgChannels({workspaceId:manager.workspaceId,scopeId,actorId:outsiderId,groupIds:[],limit:200},db)).toHaveLength(0);
    // These use the actual Hono/NIP-98 route, with disposable fixture signers.
    const httpCreated=await request('', 'POST', {title:'HTTP editor fixture'},new Uint8Array(32).fill(64));
    expect(httpCreated.status).toBe(201);
    const httpDenied=await request('', 'POST', {title:'HTTP reader fixture'},readerKey);expect(httpDenied.status).toBe(403);
    const node=await create('Editor fixture',null,outsider);
    const changed=await runContextTree(outsider,'update',{componentId:node.id,body:{title:'Renamed by editor',expected_row_version:node.row_version}},db);
    expect(changed.component.title).toBe('Renamed by editor');
    await code(runContextTree({...outsider,scopeId:scope2},'create',{body:{title:'Forbidden'}},db),'context_not_found');
    await code(runContextTree({...outsider,workspaceId:randomUUID()},'list',{},db),'context_not_found');
    await code(runContextTree(outsider,'attach',{componentId:node.id,body:{target_type:'task',target:{record_id:privateTaskId}}},db),'target_unavailable');
    const parent=await create('Editor parent',null,outsider);
    await runContextTree(outsider,'update',{componentId:node.id,body:{parent_id:parent.id,expected_row_version:changed.component.row_version}},db);
    await code(runContextTree(outsider,'attach',{componentId:node.id,body:{target_type:'task',target:{record_id:taskId}}},db),'target_unavailable');
    // Linked-target access is an independent explicit fixture grant.
    const [targetGrant]=await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${manager.workspaceId},'actor',${outsiderId},'channel',${channelId},'task.read') RETURNING id`;
    const linked=await runContextTree(outsider,'attach',{componentId:node.id,body:{target_type:'task',target:{record_id:taskId}}},db);
    await runContextTree(outsider,'unlink',{componentId:node.id,referenceId:linked.reference.id,body:{expected_row_version:linked.reference.row_version}},db);
    await db`UPDATE flightdeck_pg_permission_grants SET revoked_at=now() WHERE id=${targetGrant!.id}`;
    expect((await db`SELECT id FROM flightdeck_pg_tasks WHERE id=${taskId} AND deleted_at IS NULL`).length).toBe(1);
    const noAdmin=await authorizeFlightDeckPgOperation({...outsider,permission:'scope.manage',resource:{type:'scope',scopeId}},db);expect(noAdmin.allowed).toBe(false);
    await code(runScopeAccess(outsider,{principal_type:'actor',principal_id:outsiderId,role:'scope_manager'},db),'permission_denied');
    const preview=(await runContextTree(outsider,'preview',{componentId:node.id},db)).preview;
    await runContextTree(outsider,'delete',{componentId:node.id,body:{confirmation_token:preview.confirmation_token}},db);
    const next=await runScopeAccess(manager,undefined,db), nextLease=await acquireFlightDeckPgEditLease({workspaceId:manager.workspaceId,entityType:'scope',entityId:scopeId,actorId,actorNpub:manager.actorNpub},db);
    if(!nextLease.ok)throw Error('lease');
    await runScopeAccess(manager,{principal_type:'actor',principal_id:outsiderId,revoke:true,expected_revision:next.revision,lease_token:nextLease.lease.lease_token},db);
    await code(runContextTree(outsider,'list',{},db),'context_not_found');
  });
  test('signed Scope Access routes enforce manager/lease/CAS and deny reader escalation', async () => {
    const route=async(path:string,method='GET',body?:object,key=managerKey)=>{
      const url=`http://localhost/api/v4/flightdeck-pg/workspaces/${manager.workspaceId}${path}`;
      const tags=[['u',url],['method',method]];if(body)tags.push(['payload',createHash('sha256').update(JSON.stringify(body)).digest('hex')]);
      const auth=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags},key);
      return app.request(url,{method,headers:{Authorization:`Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    };
    const path=`/scopes/${scopeId}/grants`;
    const current=await route(path);expect(current.status).toBe(200);const data=await current.json() as any;
    expect((await route(path,'PUT',{principal_type:'actor',principal_id:readerId,role:'scope_manager'},readerKey)).status).toBe(403);
    expect((await route('/edit-leases/acquire','POST',{entity_type:'scope',entity_id:scopeId},readerKey)).status).toBe(403);
    const acquired=await route('/edit-leases/acquire','POST',{entity_type:'scope',entity_id:scopeId});expect(acquired.status).toBe(201);
    const lease=(await acquired.json() as any).lease;
    const mutation={principal_type:'actor',principal_id:outsiderId,role:'context_editor',expected_revision:data.revision,lease_token:lease.lease_token};
    const saved=await route(path,'PUT',mutation);expect(saved.status).toBe(200);
    expect((await route(path,'PUT',mutation)).status).toBe(409);
    const agentKey=new Uint8Array(32).fill(64);
    expect((await route(`/scopes/${scopeId}`,'PATCH',{name:'Must not rename scope'},agentKey)).status).toBe(403);
    expect((await route(path,'PUT',{...mutation,role:'scope_manager'},agentKey)).status).toBe(403);
    const visible=await route(path,'GET',undefined,agentKey);expect(visible.status).toBe(200);const readerAccess=await visible.json() as any;expect(readerAccess.grants).toHaveLength(0);expect(readerAccess.principals.actors).toHaveLength(0);
    const renewed=await route('/edit-leases/acquire','POST',{entity_type:'scope',entity_id:scopeId});const l=(await renewed.json() as any).lease;
    expect((await route(path,'PUT',{principal_type:'actor',principal_id:outsiderId,revoke:true,expected_revision:(await saved.json() as any).revision,lease_token:l.lease_token})).status).toBe(200);
  });
  test('canonical nested group provenance, membership removal, revocation, CAS/lease and custom grant preservation', async () => {
    const [group]=await db`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${manager.workspaceId},'Fixture builders','custom') RETURNING id`;
    const [child]=await db`INSERT INTO flightdeck_pg_groups(workspace_id,name,kind) VALUES(${manager.workspaceId},'Fixture agents','custom') RETURNING id`;
    await db`INSERT INTO flightdeck_pg_group_edges(workspace_id,parent_group_id,child_group_id) VALUES(${manager.workspaceId},${group!.id},${child!.id})`;
    await db`INSERT INTO flightdeck_pg_group_memberships(workspace_id,group_id,actor_id) VALUES(${manager.workspaceId},${child!.id},${outsiderId})`;
    const before=await runScopeAccess(manager,undefined,db);
    await code(runScopeAccess(manager,{principal_type:'group',principal_id:group!.id,role:'context_editor',expected_revision:before.revision},db),'lease_missing');
    const lease=await acquireFlightDeckPgEditLease({workspaceId:manager.workspaceId,entityType:'scope',entityId:scopeId,actorId,actorNpub:manager.actorNpub},db);if(!lease.ok)throw Error('lease');
    const mutation={principal_type:'group',principal_id:group!.id,role:'context_editor',expected_revision:before.revision,lease_token:lease.lease.lease_token};
    const saved=await runScopeAccess(manager,mutation,db);
    expect(saved.effective_access.find(e=>e.actor_id===outsiderId)?.sources.some(s=>s.via==='Fixture builders')).toBe(true);
    expect((await runContextTree(outsider,'list',{},db)).capabilities.edit).toBe(true);
    await code(runScopeAccess(manager,mutation,db),'scope_access_conflict');
    await db`DELETE FROM flightdeck_pg_group_memberships WHERE workspace_id=${manager.workspaceId} AND group_id=${child!.id} AND actor_id=${outsiderId}`;
    await code(runContextTree(outsider,'list',{},db),'context_not_found');
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_group_id,resource_type,resource_scope_id,permission) VALUES(${manager.workspaceId},'group',${group!.id},'scope',${scopeId},'channel.create')`;
    const roleEdit=async (change:object) => {const current=await runScopeAccess(manager,undefined,db);const l=await acquireFlightDeckPgEditLease({workspaceId:manager.workspaceId,entityType:'scope',entityId:scopeId,actorId,actorNpub:manager.actorNpub},db);if(!l.ok)throw Error('lease');return runScopeAccess(manager,{principal_type:'group',principal_id:group!.id,expected_revision:current.revision,lease_token:l.lease.lease_token,...change},db);};
    await roleEdit({role:'scope_manager'});await roleEdit({role:'context_editor'});
    expect((await runScopeAccess(manager,undefined,db)).grants.find(g=>g.principal_id===group!.id)?.permissions).toContain('scope.manage');
    const revoked=await roleEdit({revoke:true});expect(revoked.grants.find(g=>g.principal_id===group!.id)?.permissions).toEqual(['channel.create']);
    await db`DELETE FROM flightdeck_pg_groups WHERE workspace_id=${manager.workspaceId} AND id IN (${group!.id},${child!.id})`;
  });
  test('archive serialization makes scope unavailable; no editable active tree', async () => {
    const a=await create('Archive Scope',null,{...manager,scopeId:scope2});
    await db`UPDATE flightdeck_pg_scopes SET archived_at=NOW() WHERE id=${scope2}`;
    await code(runContextTree({...manager,scopeId:scope2},'list',{},db),'context_not_found');
    await code(runContextTree({...manager,scopeId:scope2},'update',{componentId:a.id,body:{title:'blocked',expected_row_version:1}},db),'context_not_found');
  });
});
