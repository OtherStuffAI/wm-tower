import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';

const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('Canvas comments signed API against disposable local Postgres', () => {
  const database = `canvas_comments_${process.pid}_${Date.now()}`;
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
  test('signed author/manager permissions, CAS, reply deletion and atomic root tombstones survive reread', async () => {
    const root = await create(), reply = await create('Bob reply', 2, root.id);
    expect((await request(`/comments/${root.id}`, 'DELETE', 2, { expected_row_version: 1, expected_reply_versions: { [reply.id]: 1 } })).status).toBe(403);
    expect((await request(`/comments/${root.id}`, 'DELETE', 1, { expected_row_version: 1, expected_reply_versions: { [reply.id]: 1 } })).status).toBe(403);
    expect((await request(`/comments/${reply.id}`, 'DELETE', 1, { expected_row_version: 1 })).status).toBe(403);
    expect((await request(`/comments/${reply.id}`, 'DELETE', 2, { expected_row_version: 2 })).status).toBe(409);
    expect((await request(`/comments/${root.id}`, 'DELETE', 0, { expected_row_version: 1, expected_reply_versions: {} })).status).toBe(409);
    expect((await request(`/comments/${reply.id}`, 'DELETE', 2, { expected_row_version: 1 })).status).toBe(200);
    expect((await request('/snapshot', 'GET', 1)).body.comments.map((r: any) => r.id)).toEqual([root.id]);
    const ownReply = await create('Alice reply', 1, root.id);
    expect((await request(`/comments/${root.id}`, 'DELETE', 1, { expected_row_version: 1, expected_reply_versions: { [ownReply.id]: 1 } })).status).toBe(200);
    expect((await request('/snapshot', 'GET', 1)).body.comments).toEqual([]);
    const rows = await db`SELECT id, deleted_at, row_version FROM flightdeck_pg_canvas_comments WHERE canvas_id = ${canvas}`;
    expect(rows).toHaveLength(3); expect(rows.every(row => row.deleted_at && row.row_version === 2)).toBe(true);
    const events = await db`SELECT entity_id FROM flightdeck_pg_outbox_events WHERE event_type = 'flightdeck_pg.canvas_comment.deleted'`;
    expect(events).toHaveLength(3);
  });
  test('explicit retargeting updates replies, rejects denied targets and follows target geometry in agent reads', async () => {
    const root = await create(), reply = await create('Reply', 1, root.id);
    expect((await request(`/comments/${root.id}`, 'PATCH', 2, { expected_row_version: 1, anchor: { type: 'naplet', naplet_id: naplet } })).status).toBe(403);
    const bob = await create('Bob own root', 2);
    expect((await request(`/comments/${bob.id}`, 'PATCH', 2, { expected_row_version: 1, anchor: { type: 'naplet', naplet_id: naplet } })).status).toBe(400);
    expect((await request(`/comments/${root.id}`, 'PATCH', 1, { expected_row_version: 1, anchor: { type: 'naplet', naplet_id: naplet } })).status).toBe(200);
    expect((await request(`/comments/${root.id}`, 'PATCH', 1, { expected_row_version: 1, resolved: true })).status).toBe(409);
    const snapshot = (await request('/snapshot', 'GET', 1)).body;
    expect(snapshot.comments.find((c: any) => c.id === reply.id).anchor).toEqual({ type: 'naplet', naplet_id: naplet, x: 40, y: 60 });
    const spatial = snapshot.spatial_context.comments.find((c: any) => c.comment_id === root.id);
    expect(spatial.explicit_target).toEqual({ type: 'naplet', id: naplet, authority: 'explicit' });
    expect(spatial.position).toEqual({ x: 40, y: 60 });
    await db`UPDATE flightdeck_pg_canvas_naplets SET layout = layout || '{"x":500}'::jsonb WHERE id = ${naplet}`;
    const moved = (await request('/snapshot', 'GET', 1)).body.spatial_context.comments.find((c: any) => c.comment_id === root.id);
    expect(moved.position).toEqual({ x: 40, y: 60 });
    expect((await request('/snapshot', 'GET', 1)).body.spatial_context.items.find((item: any) => item.id === naplet).bounds.x).toBe(500);
    const denied = (await request('/snapshot', 'GET', 2)).body;
    expect(denied.comments.find((c: any) => c.id === root.id).anchor.type).toBe('canvas');
    expect(JSON.stringify(denied.spatial_context)).not.toContain(naplet);
    expect((await request(`/comments/${root.id}`, 'PATCH', 1, { expected_row_version: 2, resolved: true })).status).toBe(200);
    expect((await request(`/comments/${root.id}`, 'PATCH', 1, { expected_row_version: 3, resolved: false })).status).toBe(200);
  });
});
