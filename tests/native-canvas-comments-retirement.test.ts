import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { canvasSpatialContext } from '../src/services/canvas-spatial-context';
import { Hono } from 'hono';
import { flightDeckPgRouter } from '../src/routes/flightdeck-pg';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { listVisibleFlightDeckPgEvents } from '../src/services/flightdeck-pg-api';

const schema = readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8');
const retirement = schema.split('-- native_canvas_comments_retirement_v1')[1]!.split('-- end_native_canvas_comments_retirement_v1')[0]!;

test('retired routes cannot accept cached writes and spatial snapshots omit comments', async () => {
  const app = new Hono().route('/api/v4/flightdeck-pg', flightDeckPgRouter);
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['PATCH', '/old'], ['DELETE', '/old']]) {
    const response = await app.request(`/api/v4/flightdeck-pg/workspaces/old/canvases/old/comments${suffix}`, { method });
    expect(response.status).toBe(404);
  }
  const bounds = { x: 1, y: 2, width: 100, height: 100, z: 1 };
  const spatial = canvasSpatialContext([{ id: 'readable', access: 'ready', layout: bounds }, { id: 'denied', access: 'denied', layout: bounds }], [{ id: 'legacy', kind: 'rectangle', layout: bounds }]);
  expect(spatial).not.toHaveProperty('comments');
  expect(spatial.items.map(item => item.id)).toEqual(['readable', 'legacy']);
  expect(schema).not.toContain('CREATE TABLE IF NOT EXISTS flightdeck_pg_canvas_comments');
});

const port = Number(process.env.RECORD_TEST_PORT);
describe.skipIf(!port || port === 5432)('native comment retirement in disposable Postgres', () => {
  test('fresh bootstrap, full legacy FKs, queued delivery cleanup and repeat startup preserve unrelated data', async () => {
    const options = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
    const name = `native_comment_retirement_${process.pid}_${Date.now()}`;
    const admin = postgres({ ...options, database: 'postgres' });
    let db: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
      db = postgres({ ...options, database: name });
      for (const statement of splitSqlStatements(schema)) await db.unsafe(statement);
      expect((await db`SELECT to_regclass('flightdeck_pg_canvas_comments') AS name`)[0]!.name).toBeNull();
      // Upgrade fixture is the real previous table definition, including self,
      // naplet, membership and canvas FKs.
      await db.unsafe(readFileSync(new URL('./fixtures/native-canvas-comments-legacy.sql', import.meta.url), 'utf8'));
      const [workspace] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('test','test','test','test','retirement') RETURNING id`;
      const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('test','human') RETURNING id`;
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace!.id},${actor!.id},'owner')`;
      const [canvas] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},'preserved',1,${actor!.id},${actor!.id}) RETURNING id`;
      const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace!.id},'preserved','project') RETURNING id`;
      const [channel] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace!.id},${scope!.id},'preserved') RETURNING id`;
      const [thread] = await db`INSERT INTO flightdeck_pg_threads(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${scope!.id},${channel!.id},'conversation',${actor!.id},${actor!.id}) RETURNING id`;
      await db`INSERT INTO flightdeck_pg_messages(workspace_id,scope_id,channel_id,thread_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${scope!.id},${channel!.id},${thread!.id},'preserved conversation',${actor!.id},${actor!.id})`;
      await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${canvas!.id},'chat_thread',${thread!.id},${actor!.id},${actor!.id})`;
      for (const kind of ['text','rectangle','diamond','ellipse','arrow','line','draw','frame']) await db`INSERT INTO flightdeck_pg_canvas_elements(workspace_id,canvas_id,kind,layout,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${canvas!.id},${kind},'{"x":1,"y":2,"width":100,"height":100,"z":1}',${actor!.id},${actor!.id})`;
      const [storage] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,storage_path) VALUES('test','test','text/plain','retirement-test') RETURNING id`;
      const [doc] = await db`INSERT INTO flightdeck_pg_docs(workspace_id,scope_id,channel_id,storage_object_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${scope!.id},${channel!.id},${storage!.id},'preserved',${actor!.id},${actor!.id}) RETURNING id`;
      await db`INSERT INTO flightdeck_pg_doc_comments(workspace_id,scope_id,channel_id,doc_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${scope!.id},${channel!.id},${doc!.id},'keep this document comment',${actor!.id},${actor!.id})`;
      const [task] = await db`INSERT INTO flightdeck_pg_tasks(workspace_id,scope_id,channel_id,title,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${scope!.id},${channel!.id},'preserved',${actor!.id},${actor!.id}) RETURNING id`;
      await db`INSERT INTO flightdeck_pg_task_comments(workspace_id,scope_id,channel_id,task_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${scope!.id},${channel!.id},${task!.id},'keep this task comment',${actor!.id},${actor!.id})`;
      const preservedTables = ['flightdeck_pg_threads','flightdeck_pg_messages','flightdeck_pg_canvas_naplets','flightdeck_pg_canvas_elements','flightdeck_pg_docs','flightdeck_pg_doc_comments','flightdeck_pg_tasks','flightdeck_pg_task_comments'];
      const before = await Promise.all(preservedTables.map(table => db!.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)));
      const [root] = await db`INSERT INTO flightdeck_pg_canvas_comments(workspace_id,canvas_id,anchor_type,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${canvas!.id},'canvas','removed',${actor!.id},${actor!.id}) RETURNING id`;
      await db`INSERT INTO flightdeck_pg_canvas_comments(workspace_id,canvas_id,anchor_type,parent_comment_id,body,created_by_actor_id,updated_by_actor_id) VALUES(${workspace!.id},${canvas!.id},'canvas',${root!.id},'reply',${actor!.id},${actor!.id})`;
      for (const status of ['pending','processing','failed','published']) await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,entity_type,event_type,status) VALUES(${workspace!.id},'canvas_comment','flightdeck_pg.canvas_comment.created',${status})`;
      await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,entity_type,event_type) VALUES(${workspace!.id},'unknown','flightdeck_pg.canvas_comment.created')`;
      await db`INSERT INTO flightdeck_pg_outbox_events(workspace_id,entity_type,event_type) VALUES(${workspace!.id},'chat_message','flightdeck_pg.message.created')`;
      await db`INSERT INTO flightdeck_pg_notification_deliveries(workspace_id,outbox_event_id,recipient_actor_id,category,source_entity_type,dedupe_key,decision,title,body)
        SELECT workspace_id,id,${actor!.id},'comment_tag','canvas_comment',id::text,'queued','legacy','removed'
        FROM flightdeck_pg_outbox_events WHERE entity_type='canvas_comment'`;
      const visible = await listVisibleFlightDeckPgEvents({ workspaceId: workspace!.id, actorId: actor!.id, groupIds: [], afterRowVersion: 0, limit: 100, includeWorkspaceEvents: true }, db);
      expect(visible.some(event => event.entity_type === 'canvas_comment' || event.event_type.startsWith('flightdeck_pg.canvas_comment.'))).toBe(false);
      await db.unsafe('CREATE TABLE retirement_external_probe(comment_id uuid REFERENCES flightdeck_pg_canvas_comments(id))');
      await db`INSERT INTO retirement_external_probe VALUES(${root!.id})`;
      await expect(db.begin(async tx => { await tx.unsafe(retirement); })).rejects.toThrow();
      expect(await db`SELECT * FROM flightdeck_pg_canvas_comments`).toHaveLength(2);
      await db.unsafe('DROP TABLE retirement_external_probe');
      await db.begin(async tx => { await tx.unsafe(retirement); });
      await db.unsafe(retirement);
      expect((await db`SELECT to_regclass('flightdeck_pg_canvas_comments') AS name`)[0]!.name).toBeNull();
      expect(await db`SELECT * FROM flightdeck_pg_notification_deliveries`).toHaveLength(0);
      expect(await db`SELECT * FROM flightdeck_pg_outbox_events WHERE entity_type='canvas_comment'`).toHaveLength(0);
      expect(await db`SELECT * FROM flightdeck_pg_outbox_events WHERE entity_type='chat_message'`).toHaveLength(1);
      expect(await db`SELECT * FROM flightdeck_pg_canvases WHERE id=${canvas!.id}`).toHaveLength(1);
      await ensureRuntimeSchema(db);
      await ensureRuntimeSchema(db);
      expect((await db`SELECT to_regclass('flightdeck_pg_canvas_comments') AS name`)[0]!.name).toBeNull();
      const after = await Promise.all(preservedTables.map(table => db!.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)));
      expect(after).toEqual(before);

    } finally {
      await db?.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  }, 60000);
});
