import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';

const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('Task Tree signed API against disposable local Postgres', () => {
  const database = `task_tree_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const secrets = [111, 112, 113].map(n => new Uint8Array(32).fill(n));
  let db: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>, workspace: string, canvas: string, naplet: string;
  let actors: string[]; let channelId: string;
  const rootPath = () => `/api/v4/flightdeck-pg/workspaces/${workspace}`;
  async function request(suffix: string, method = 'GET', actor = 0, body?: any) {
    const path = rootPath() + suffix, data = body === undefined ? undefined : JSON.stringify(body);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', createHash('sha256').update(data).digest('hex')]] : [])] }, secrets[actor]!);
    const response = await app.request(path, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' }, body: data });
    return { status: response.status, body: await response.json() as any };
  }
  beforeAll(async () => {
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    actors = [];
    for (const secret of secrets) {
      const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${nip19.npubEncode(getPublicKey(secret))},'human') RETURNING id`;
      actors.push(actor!.id);
    }
    const [ws] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service',${nip19.npubEncode(getPublicKey(secrets[0]!))},'app','Canvas test') RETURNING id`;
    workspace = ws!.id;
    for (const [i, actor] of actors.entries()) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor},${i === 0 ? 'owner' : 'member'})`;
    const [row] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Test',1,${actors[0]!},${actors[0]!}) RETURNING id`;
    canvas = row!.id;
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace},'Test','project') RETURNING id`;
    const [channel] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope!.id},'Readable only by Alice') RETURNING id`;
    channelId = channel!.id;
    for (const permission of ['task.read','task.create','task.update']) await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[0]!},'channel',${channelId},${permission})`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[1]!},'channel',${channel!.id},'task.read')`;
    const [item] = await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},${canvas},'task_list',${channel!.id},'{"x":100,"y":50,"width":300,"height":200,"z":1}',${actors[0]!},${actors[0]!}) RETURNING id`;
    naplet = item!.id;
    setDb(db); app = createApp();
  });
  afterAll(async () => {
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });

  const create = async (title: string, metadata = {}, key = crypto.randomUUID()) => {const result=await request(`/channels/${channelId}/tasks`, 'POST', 0, {title, metadata, client_request_id:key});if(![200,201,409].includes(result.status))console.log(result);return result;};
  test('atomic relationships, exact/concurrent replay and conflicting reuse', async () => {
    const root = (await create('Root')).body.task;
    const key=crypto.randomUUID(), metadata={parent_task_id:root.id,predecessor_task_ids:[root.id]};
    const results=await Promise.all([create('Child',metadata,key),create('Child',metadata,key)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,201]);
    expect(results[0].body.task.id).toBe(results[1].body.task.id);
    expect(results[0].body.task.metadata).toMatchObject(metadata);
    expect((await create('Changed',metadata,key)).status).toBe(409);
    const count=await db`SELECT count(*)::int AS n FROM flightdeck_pg_tasks WHERE id=${results[0].body.task.id}`;
    expect(count[0]!.n).toBe(1);
  });
  test('canonical CAS, self, duplicate, cycles and missing/inaccessible references', async()=>{
    const root=(await create('Ancestor')).body.task, child=(await create('Descendant',{parent_task_id:root.id,predecessor_task_ids:[root.id]})).body.task;
    const patch=(metadata:any,version=root.row_version)=>request(`/tasks/${root.id}`,'PATCH',0,{metadata,row_version:version});
    expect((await patch({parent_task_id:root.id})).status).toBe(400);
    expect((await patch({parent_task_id:child.id})).status).toBe(400);
    expect((await patch({predecessor_task_ids:[child.id]})).status).toBe(400);
    expect((await patch({predecessor_task_ids:[child.id,child.id]})).status).toBe(400);
    expect((await patch({parent_task_id:crypto.randomUUID()})).status).toBe(400);
    expect((await patch({parent_task_id:null},999)).status).toBe(409);
    expect((await patch({parent_task_id:null})).status).toBe(200);
    expect((await patch({parent_task_id:null})).status).toBe(409);
    const denied=await request(`/channels/${channelId}/tasks`,'POST',1,{title:'Denied'});
    expect(denied.status).toBe(403);
  });
  test('adjacency pagination returns shared successors once per page and hides denied content',async()=>{
    const root=(await create('Graph')).body.task;
    const a=(await create('A',{parent_task_id:root.id})).body.task;
    const b=(await create('B',{parent_task_id:root.id})).body.task;
    const shared=(await create('Shared',{predecessor_task_ids:[a.id,b.id]})).body.task;
    const first=await request(`/tasks/${root.id}/relationships?limit=1`);
    expect(first.status).toBe(200);expect(first.body.has_more).toBe(true);expect(first.body.tasks.length).toBe(1);
    const second=await request(`/tasks/${root.id}/relationships?limit=1&cursor=${first.body.next_cursor}`);
    expect(second.body.tasks.length).toBe(1);expect(second.body.has_more).toBe(false);
    expect(new Set([...first.body.tasks,...second.body.tasks].map((t:any)=>t.id)).size).toBe(2);
    for (const task of [a,b]) expect((await request(`/tasks/${task.id}/relationships`)).body.tasks[0].id).toBe(shared.id);
    expect((await request(`/tasks/${root.id}/relationships`,'GET',2)).status).toBe(404);
    await db`UPDATE flightdeck_pg_tasks SET deleted_at=now() WHERE id=${a.id}`;
    const page=await request(`/tasks/${root.id}/relationships`);
    expect(page.body.unavailable).toBe(true);expect(JSON.stringify(page.body)).not.toContain('"title":"A"');
  });
  test('Task Tree view state persists with channel authority and source ACL redaction',async()=>{
    const root=(await create('Bound root')).body.task;
    const tree={root_task_id:root.id,collapsed:[root.id],upstream:[],instance_id:crypto.randomUUID(),viewport:{x:10,y:20,scale:0.7}};
    const layout={x:0,y:0,width:800,height:600,z:1,task_tree:tree};
    const made=await request(`/canvases/${canvas}/naplets`,'POST',0,{source:{type:'task_tree',id:channelId},layout});
    expect(made.status).toBe(201);expect(made.body.naplet.layout.task_tree).toEqual(tree);
    expect(made.body.naplet.content.can_create).toBe(true);
    const snapshot=await request(`/canvases/${canvas}/snapshot`);
    expect(snapshot.body.naplets.find((n:any)=>n.id===made.body.naplet.id).layout.task_tree).toEqual(tree);
    const denied=await request(`/canvases/${canvas}/snapshot`,'GET',2);
    expect(denied.body.naplets.find((n:any)=>n.id===made.body.naplet.id).access).toBe('denied');
  });
  test('existing source constraint upgrades idempotently and channel-only rebind clears prior graph',async()=>{
    const [other]=await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) SELECT workspace_id,scope_id,'Second destination' FROM flightdeck_pg_channels WHERE id=${channelId} RETURNING id`;
    for(const permission of ['task.read','task.create'])await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[0]!},'channel',${other!.id},${permission})`;
    const made=await request(`/canvases/${canvas}/naplets`,'POST',0,{source:{type:'task_tree',id:channelId},layout:{task_tree:{root_task_id:crypto.randomUUID(),collapsed:[crypto.randomUUID()],viewport:{x:1,y:2,scale:1}}}});
    const changed=await request(`/canvases/${canvas}/naplets/${made.body.naplet.id}`,'PATCH',0,{expected_row_version:made.body.naplet.row_version,tree_channel_id:other!.id});
    expect(changed.status).toBe(200);expect(changed.body.naplet.source.id).toBe(other!.id);expect(changed.body.naplet.layout.task_tree.root_task_id).toBe(null);expect(changed.body.naplet.layout.task_tree.collapsed).toEqual([]);
    await db`DELETE FROM flightdeck_pg_canvas_naplets WHERE source_type='task_tree'`;
    await db.unsafe("ALTER TABLE flightdeck_pg_canvas_naplets DROP CONSTRAINT flightdeck_pg_canvas_naplets_source_type_check");
    await db.unsafe("ALTER TABLE flightdeck_pg_canvas_naplets ADD CONSTRAINT flightdeck_pg_canvas_naplets_source_type_check CHECK (source_type IN ('document','task_list','chat_thread','html','excalidraw','canvas'))");
    const upgrade=readFileSync(new URL('../src/schema/001_init.sql',import.meta.url),'utf8').split('-- flightdeck_pg_canvas_v1')[1]!.split('-- end_flightdeck_pg_canvas_v1')[0]!;
    for(let n=0;n<2;n++)for(const statement of splitSqlStatements(upgrade))await db.unsafe(statement);
    const [constraint]=await db`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='flightdeck_pg_canvas_naplets_source_type_check'`;
    expect(constraint!.definition).toContain('task_tree');
  });

});
