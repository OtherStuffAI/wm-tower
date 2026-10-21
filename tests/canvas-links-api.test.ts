import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';

const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('Canvas links signed API against disposable local Postgres', () => {
  const database = `canvas_links_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const secrets = [111, 112, 113].map(n => new Uint8Array(32).fill(n));
  let db: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>, workspace: string, canvas: string, naplet: string;
  let actors: string[];
  const rootPath = () => `/api/v4/flightdeck-pg/workspaces/${workspace}/canvases/${canvas}`;
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
    const [ws] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service','owner','app','Canvas test') RETURNING id`;
    workspace = ws!.id;
    for (const [i, actor] of actors.entries()) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor},${i === 0 ? 'owner' : 'member'})`;
    const [row] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Test',1,${actors[0]!},${actors[0]!}) RETURNING id`;
    canvas = row!.id;
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace},'Test','project') RETURNING id`;
    const [channel] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope!.id},'Readable only by Alice') RETURNING id`;
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[1]!},'channel',${channel!.id},'task.read')`;
    const [item] = await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},${canvas},'task_list',${channel!.id},'{"x":100,"y":50,"width":300,"height":200,"z":1}',${actors[0]!},${actors[0]!}) RETURNING id`;
    naplet = item!.id;
    setDb(db); app = createApp();
  });
  afterAll(async () => {
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });
  async function create(body = 'Root', actor = 1, parent?: string) {
    const result = await request('/comments', 'POST', actor, { body, parent_comment_id: parent, anchor: { type: 'canvas', x: 40, y: 60 } });
    expect(result.status).toBe(201); return result.body.comment;
  }
  test('title-only links preserve independent ACLs, support cycles and redact revocation/deletion', async () => {
    const b = (await request('', 'GET')).body; // Definition route confirms source canvas.
    expect(b.canvas.id).toBe(canvas);
    const created = await app.request('/health'); expect(created.status).toBe(200);
    const [destination] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,visibility_mode,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Restricted destination',2,'restricted',${actors[0]!},${actors[0]!}) RETURNING id`;
    const target = destination!.id;
    const layout = { x: 20, y: 30, width: 380, height: 280, z: 2 };
    const body = { source: { type: 'canvas', id: target }, title: 'Overview', layout };
    const link = await request('/naplets', 'POST', 0, body);
    expect(link.status).toBe(201);
    expect(link.body.naplet.content).toEqual({ title: 'Restricted destination' });
    expect(link.body.naplet.title).toBe('Overview');
    expect((await request('/naplets', 'POST', 0, { ...body, source: { type: 'canvas', id: canvas } })).status).toBe(400);
    expect((await request('/naplets', 'POST', 0, { ...body, source: { ...body.source, version_id: crypto.randomUUID() } })).status).toBe(400);
    const sourceCanvas = canvas;
    const [memberCanvas] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Member source',3,${actors[1]!},${actors[1]!}) RETURNING id`;
    canvas = memberCanvas!.id;
    expect((await request('/naplets', 'POST', 1, body)).status).toBe(400);
    canvas = sourceCanvas;
    // A canvas id in a foreign workspace is never a valid source.
    const [foreignWorkspace] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower2','service2','owner2','app','Foreign') RETURNING id`;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${foreignWorkspace!.id},${actors[0]!},'owner')`;
    const [foreign] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${foreignWorkspace!.id},'Foreign canvas',1,${actors[0]!},${actors[0]!}) RETURNING id`;
    expect((await request('/naplets', 'POST', 0, { ...body, source: { type: 'canvas', id: foreign!.id } })).status).toBe(400);
    const unavailable = (await request('/snapshot', 'GET', 1)).body.naplets.find((n: any) => n.id === link.body.naplet.id);
    expect(Object.keys(unavailable).sort()).toEqual(['access','id','layout','row_version']);
    expect(unavailable.access).toBe('denied');
    await db`INSERT INTO flightdeck_pg_canvas_visibility_principals(workspace_id,canvas_id,principal_type,principal_actor_id,created_by_actor_id) VALUES(${workspace},${target},'actor',${actors[1]!},${actors[0]!})`;
    expect((await request('/snapshot', 'GET', 1)).body.naplets.find((n: any) => n.id === link.body.naplet.id).content).toEqual({ title: 'Restricted destination' });
    await db`UPDATE flightdeck_pg_canvases SET title='Renamed destination' WHERE id=${target}`;
    expect((await request('/snapshot', 'GET', 1)).body.naplets.find((n: any) => n.id === link.body.naplet.id).content).toEqual({ title: 'Renamed destination' });
    // Cycles are references only: B -> A resolves without reading A's naplets.
    await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},${target},'canvas',${canvas},${db.json(layout)},${actors[0]!},${actors[0]!})`;
    expect((await request('/snapshot')).status).toBe(200);
    await db`DELETE FROM flightdeck_pg_canvas_visibility_principals WHERE canvas_id=${target}`;
    expect((await request('/snapshot', 'GET', 1)).body.naplets.find((n: any) => n.id === link.body.naplet.id)).toEqual(unavailable);
    await db`UPDATE flightdeck_pg_canvases SET deleted_at=now() WHERE id=${target}`;
    expect((await request('/snapshot')).body.naplets.find((n: any) => n.id === link.body.naplet.id).access).toBe('denied');
    expect((await request('/naplets', 'POST', 0, body)).status).toBe(400);
    expect((await request('/naplets', 'POST', 0, { ...body, source: { type: 'canvas', id: crypto.randomUUID() } })).body.error).toBeDefined();
  });

  test('runtime schema upgrade admits canvas references without weakening pin constraints', async () => {
    await db`DELETE FROM flightdeck_pg_canvas_naplets WHERE source_type='canvas'`;
    await db.unsafe("ALTER TABLE flightdeck_pg_canvas_naplets DROP CONSTRAINT flightdeck_pg_canvas_naplets_source_type_check");
    await db.unsafe("ALTER TABLE flightdeck_pg_canvas_naplets ADD CONSTRAINT flightdeck_pg_canvas_naplets_source_type_check CHECK (source_type IN ('document','task_list','chat_thread','html','excalidraw'))");
    const sql = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8').split('-- flightdeck_pg_canvas_v1')[1]!.split('-- end_flightdeck_pg_canvas_v1')[0]!;
    for (const statement of splitSqlStatements(sql)) await db.unsafe(statement);
    const [constraint] = await db`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='flightdeck_pg_canvas_naplets_source_type_check'`;
    expect(constraint!.definition).toContain('canvas');
    const [pin] = await db`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='flightdeck_pg_canvas_naplets_version_pin_check'`;
    expect(pin!.definition).toContain("source_type = 'html'");
  });
});
