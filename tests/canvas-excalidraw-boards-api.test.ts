import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, writeStorageObject } from '../src/services/storage';

const port = Number(process.env.RECORD_TEST_PORT);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const BOARD = 'application/vnd.excalidraw+json';
const layout = { x: 0, y: 0, width: 480, height: 360, z: 1 };
const READY_KEYS = ['can_write', 'content_type', 'current_version_id', 'current_version_number', 'file_id', 'sha256', 'size_bytes', 'updated_at', 'updated_by_actor_npub'];
// postgres.js queries are lazy thenables; settle them explicitly to read the error.
const failure = (query: PromiseLike<unknown>) => Promise.resolve(query).then(() => 'succeeded', (error: Error) => error.message);
const scene = (label: string) => encoder.encode(JSON.stringify({
  type: 'excalidraw', version: 2, source: 'wingman',
  elements: [{ id: 'el-1', type: 'text', text: label, version: 3, versionNonce: 7, isDeleted: false }, { id: 'el-0', type: 'rectangle', version: 2, isDeleted: true }],
  appState: {}, files: {}, wingman: { summary: label },
}));

describe.skipIf(!port || port === 5432)('Excalidraw board naplets signed API against disposable local Postgres', () => {
  const database = `canvas_excalidraw_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 = owner (file.read+file.write on A and B), 1 = reader of A, 2 = member without file access,
  // 3 = file.read + channel.write on A (writes through the storage attach rule).
  const secrets = [131, 132, 133, 134].map(n => new Uint8Array(32).fill(n));
  const npubs = secrets.map(secret => nip19.npubEncode(getPublicKey(secret)));
  let db: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>;
  let workspace: string, canvas: string, canvas2: string, channelA: string, channelB: string, actors: string[];

  async function request(path: string, method = 'GET', actor = 0, body?: unknown) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', sha(encoder.encode(data))]] : [])] }, secrets[actor]!);
    const response = await app.request(path, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' }, body: data });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, body: type.startsWith('application/json') ? await response.json() as any : new Uint8Array(await response.arrayBuffer()) };
  }
  const ws = (suffix: string) => `/api/v4/flightdeck-pg/workspaces/${workspace}${suffix}`;
  const cv = (suffix: string, id = canvas) => ws(`/canvases/${id}${suffix}`);
  const grant = (actor: string, channel: string, permission: string) =>
    db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actor},'channel',${channel},${permission})`;

  async function storeObject(bytes: Uint8Array, contentType: string) {
    const [row] = await db`
      INSERT INTO v4_storage_objects(owner_npub, created_by_npub, file_name, content_type, size_bytes, storage_path)
      VALUES (${npubs[0]!}, ${npubs[0]!}, 'board.excalidraw', ${contentType}, ${bytes.byteLength}, ${`test/${crypto.randomUUID()}`}) RETURNING id`;
    expect(await writeStorageObject(row!.id, bytes, npubs[0]!)).not.toBeNull();
    await db`UPDATE v4_storage_objects SET completed_at = NOW(), sha256_hex = ${sha(bytes)} WHERE id = ${row!.id}`;
    return row!.id as string;
  }
  async function createBoard(channelId: string, bytes: Uint8Array, name: string, extra: Record<string, unknown> = {}, contentType = BOARD) {
    const objectId = await storeObject(bytes, contentType);
    const created = await request(ws(`/channels/${channelId}/files`), 'POST', 0, { storage_object_id: objectId, display_name: name, ...extra });
    expect(created.status).toBe(201);
    return { fileId: created.body.file.id as string, versionId: created.body.file.current_version_id as string };
  }
  async function save(fileId: string, baseVersionId: string, bytes: Uint8Array, actor = 0, extra: Record<string, unknown> = {}, contentType = BOARD) {
    const objectId = await storeObject(bytes, contentType);
    return request(ws(`/files/${fileId}/versions`), 'POST', actor, { base_version_id: baseVersionId, storage_object_id: objectId, ...extra });
  }
  const napletIn = async (actor: number, id: string, canvasId = canvas) =>
    (await request(cv('/snapshot', canvasId), 'GET', actor)).body.naplets.find((row: any) => row.id === id);

  beforeAll(async () => {
    enableInMemoryStorageForTest();
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    actors = [];
    for (const npub of npubs) actors.push((await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`)[0]!.id);
    workspace = (await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service',${npubs[0]!},'app','Boards') RETURNING id`)[0]!.id;
    for (const [i, actor] of actors.entries()) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor},${i === 0 ? 'owner' : 'member'})`;
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace},'Boards','project') RETURNING id`;
    channelA = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope!.id},'Boards') RETURNING id`)[0]!.id;
    channelB = (await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope!.id},'Restricted') RETURNING id`)[0]!.id;
    for (const channel of [channelA, channelB]) for (const permission of ['file.read', 'file.write']) await grant(actors[0]!, channel, permission);
    await grant(actors[1]!, channelA, 'file.read');
    await grant(actors[3]!, channelA, 'file.read');
    await grant(actors[3]!, channelA, 'channel.write');
    canvas = (await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Boards',1,${actors[0]!},${actors[0]!}) RETURNING id`)[0]!.id;
    canvas2 = (await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Second',2,${actors[0]!},${actors[0]!}) RETURNING id`)[0]!.id;
    setDb(db); app = createApp();
  });
  afterAll(async () => {
    resetInMemoryStorageForTest();
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });

  test('projects metadata only, follows latest, re-authorizes viewers and shares one board across canvases', async () => {
    const v1Bytes = scene('first draft');
    const board = await createBoard(channelA, v1Bytes, 'Suite board', { summary: '  Initial layout  ' });
    let versions = await request(ws(`/files/${board.fileId}/versions`));
    expect(versions.body.versions[0]).toMatchObject({ id: board.versionId, version_number: 1, summary: 'Initial layout', created_by_actor_npub: npubs[0] });

    const created = await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: board.fileId }, layout });
    expect(created.status).toBe(201);
    const napletId = created.body.naplet.id as string;
    expect(created.body.naplet.source).toEqual({ type: 'excalidraw', id: board.fileId });
    expect(created.body.naplet.title).toBe('Suite board');
    expect(Object.keys(created.body.naplet.content).sort()).toEqual(READY_KEYS);
    expect(created.body.naplet.content).toMatchObject({
      file_id: board.fileId, current_version_id: board.versionId, current_version_number: 1, content_type: BOARD,
      size_bytes: v1Bytes.byteLength, sha256: sha(v1Bytes), updated_by_actor_npub: npubs[0], can_write: true,
    });
    expect(new Date(created.body.naplet.content.updated_at).toISOString()).toBe(created.body.naplet.content.updated_at);
    // Never scene bytes, URLs or credentials.
    expect(JSON.stringify(created.body.naplet)).not.toMatch(/first draft|elements|signed_url|download_url|storage_path|nsec/);
    expect((await db`SELECT source_id, source_version_id FROM flightdeck_pg_canvas_naplets WHERE id = ${napletId}`)[0]).toEqual({ source_id: board.fileId, source_version_id: null });

    // The same File on a second canvas resolves to the same board.
    const second = await request(cv('/naplets', canvas2), 'POST', 0, { source: { type: 'excalidraw', id: board.fileId }, layout });
    expect(second.status).toBe(201);

    // Reader: ready without write; channel.write member: ready with write; outsider: denied with no source fields.
    expect((await napletIn(1, napletId)).content).toMatchObject({ current_version_id: board.versionId, can_write: false });
    expect((await napletIn(3, napletId)).content.can_write).toBe(true);
    const outsider = await napletIn(2, napletId);
    expect(Object.keys(outsider).sort()).toEqual(['access', 'id', 'layout', 'row_version']);
    expect(outsider.access).toBe('denied');
    expect((await request(cv('/naplets'), 'POST', 2, { source: { type: 'excalidraw', id: board.fileId }, layout })).status).toBe(403);

    // Agents and browsers read the exact version bytes through the typed version object route.
    const bytes = await request(ws(`/files/${board.fileId}/versions/${board.versionId}/object`), 'GET', 1);
    expect(bytes.status).toBe(200);
    expect(sha(bytes.body as Uint8Array)).toBe(sha(v1Bytes));
    expect(bytes.headers.get('content-type')).toBe(BOARD);
    expect((await request(ws(`/files/${board.fileId}/versions/${board.versionId}/object`), 'GET', 2)).status).toBe(404);

    // Saving: reader cannot; channel.write member can, with summary; stale base loses without changing latest.
    expect((await save(board.fileId, board.versionId, scene('reader edit'), 1)).status).toBe(403);
    const v2Bytes = scene('second draft');
    const v2 = await save(board.fileId, board.versionId, v2Bytes, 3, { summary: 'Moved Tower box' });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toMatchObject({ version_number: 2, base_version_id: board.versionId, summary: 'Moved Tower box', content_type: BOARD });
    const stale = await save(board.fileId, board.versionId, scene('racing draft'), 0, { summary: 'Racer' });
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code ?? stale.body.code).toBe('stale_base_version');
    expect(JSON.stringify(stale.body)).toContain('Moved Tower box');

    for (const [canvasId, id] of [[canvas, napletId], [canvas2, second.body.naplet.id]] as const) {
      expect((await napletIn(1, id, canvasId)).content).toMatchObject({
        current_version_id: v2.body.version.id, current_version_number: 2, sha256: sha(v2Bytes), size_bytes: v2Bytes.byteLength, updated_by_actor_npub: npubs[3],
      });
    }
    versions = await request(ws(`/files/${board.fileId}/versions`), 'GET', 1);
    expect(versions.body.versions.map((row: any) => [row.version_number, row.summary])).toEqual([[2, 'Moved Tower box'], [1, 'Initial layout']]);

    // Boards cannot be pinned, at creation or later.
    const pinned = await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: board.fileId, version_id: board.versionId }, layout });
    expect(pinned.status).toBe(400);
    expect(JSON.stringify(pinned.body)).toContain('source.version_id');
    const row = await napletIn(0, napletId);
    const patched = await request(cv(`/naplets/${napletId}`), 'PATCH', 0, { expected_row_version: row.row_version, source_version_id: board.versionId });
    expect(patched.status).toBe(400);
    expect(JSON.stringify(patched.body)).toContain('source_version_id applies only to html naplets');
    const moved = await request(cv(`/naplets/${napletId}`), 'PATCH', 0, { expected_row_version: row.row_version, layout: { ...layout, x: 40 } });
    expect(moved.status).toBe(200);
    expect(moved.body.naplet.content.current_version_number).toBe(2);

    // Revocation denies on the next read; restoring the grant restores the board.
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE principal_actor_id = ${actors[1]!}`;
    expect((await napletIn(1, napletId)).access).toBe('denied');
    expect(Object.keys(await napletIn(1, napletId)).sort()).toEqual(['access', 'id', 'layout', 'row_version']);
    await grant(actors[1]!, channelA, 'file.read');
    expect((await napletIn(1, napletId)).access).toBe('ready');
  });

  test('rejects wrong MIME, unreadable or deleted boards and invalid summaries', async () => {
    // Non-board Files cannot become excalidraw naplets, and html naplets cannot reference boards.
    const html = await createBoard(channelA, encoder.encode('<p>html</p>'), 'Page', {}, 'text/html');
    expect((await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: html.fileId }, layout })).status).toBe(400);
    const board = await createBoard(channelA, scene('board'), 'Board');
    expect((await request(cv('/naplets'), 'POST', 0, { source: { type: 'html', id: board.fileId }, layout })).status).toBe(400);
    // A version id is not a board id.
    expect((await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: board.versionId }, layout })).status).toBe(400);
    // Media type parameters are tolerated.
    const charset = await createBoard(channelA, scene('charset'), 'Charset', {}, `${BOARD}; charset=utf-8`);
    expect((await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: charset.fileId }, layout })).status).toBe(201);

    // A board in a channel the reader cannot read is unavailable to them at placement time.
    const restricted = await createBoard(channelB, scene('restricted'), 'Restricted');
    expect((await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: restricted.fileId }, layout })).status).toBe(201);
    const restrictedNaplet = (await request(cv('/snapshot'), 'GET', 1)).body.naplets.filter((row: any) => row.access === 'denied');
    expect(restrictedNaplet.length).toBeGreaterThan(0);

    // A later non-board current version turns the naplet into the denied projection.
    const created = await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: board.fileId }, layout });
    expect(created.status).toBe(201);
    const replaced = await save(board.fileId, board.versionId, encoder.encode('png?'), 0, {}, 'image/png');
    expect(replaced.status).toBe(201);
    expect((await napletIn(0, created.body.naplet.id)).access).toBe('denied');

    // Archived and deleted Files are denied too.
    const archived = await createBoard(channelA, scene('archived'), 'Archived');
    const archivedNaplet = await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: archived.fileId }, layout });
    await db`UPDATE flightdeck_pg_files SET archived_at = NOW() WHERE id = ${archived.fileId}`;
    expect((await napletIn(0, archivedNaplet.body.naplet.id)).access).toBe('denied');
    const deleted = await createBoard(channelA, scene('deleted'), 'Deleted');
    const deletedNaplet = await request(cv('/naplets'), 'POST', 0, { source: { type: 'excalidraw', id: deleted.fileId }, layout });
    expect((await request(ws(`/files/${deleted.fileId}`), 'DELETE', 0, {})).status).toBe(200);
    expect((await napletIn(0, deletedNaplet.body.naplet.id)).access).toBe('denied');

    // Summary validation on both write routes; blank means none; 280 code points accepted.
    const fresh = await createBoard(channelA, scene('summaries'), 'Summaries');
    expect((await save(fresh.fileId, fresh.versionId, scene('x'), 0, { summary: 'x'.repeat(281) })).status).toBe(400);
    expect((await save(fresh.fileId, fresh.versionId, scene('x'), 0, { summary: 42 })).status).toBe(400);
    const objectId = await storeObject(scene('too long'), BOARD);
    expect((await request(ws(`/channels/${channelA}/files`), 'POST', 0, { storage_object_id: objectId, summary: 'y'.repeat(281) })).status).toBe(400);
    const blank = await save(fresh.fileId, fresh.versionId, scene('blank'), 0, { summary: '   ' });
    expect(blank.status).toBe(201);
    expect(blank.body.version.summary).toBeNull();
    const emoji = await save(fresh.fileId, blank.body.version.id, scene('emoji'), 0, { summary: '🎨'.repeat(280) });
    expect(emoji.status).toBe(201);
    expect([...emoji.body.version.summary].length).toBe(280);
    const none = await save(fresh.fileId, emoji.body.version.id, scene('none'));
    expect(none.status).toBe(201);
    expect(none.body.version.summary).toBeNull();
  });

  test('admits exactly one of two concurrent saves from the same base version', async () => {
    const board = await createBoard(channelA, scene('race'), 'Race');
    const [a, b] = await Promise.all([
      save(board.fileId, board.versionId, scene('left'), 0, { summary: 'left' }),
      save(board.fileId, board.versionId, scene('right'), 3, { summary: 'right' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const versions = await request(ws(`/files/${board.fileId}/versions`));
    expect(versions.body.current_version_id).toBe(winner.body.version.id);
    expect(versions.body.versions.map((row: any) => row.version_number)).toEqual([2, 1]);
  });

  test('database constraints admit excalidraw and keep version pins html-only', async () => {
    const board = await createBoard(channelA, scene('constraints'), 'Constraints');
    const insert = (type: string, versionId: string | null) => db`
      INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,source_version_id,layout,created_by_actor_id,updated_by_actor_id)
      VALUES(${workspace},${canvas},${type},${board.fileId},${versionId},${db.json(layout)},${actors[0]!},${actors[0]!})`;
    await insert('excalidraw', null);
    expect(await failure(insert('excalidraw', board.versionId))).toMatch(/version_pin_check/);
    expect(await failure(insert('document', board.versionId))).toMatch(/version_pin_check/);
    expect(await failure(insert('whiteboard', null))).toMatch(/source_type_check/);
    await insert('html', board.versionId);
    expect(await failure(db`UPDATE flightdeck_pg_file_versions SET summary = '' WHERE id = ${board.versionId}`)).toMatch(/summary_check/);
  });
});

test.skipIf(!port || port === 5432)('upgrades a deployed four-source naplet schema and summary-less File versions in place', async () => {
  const name = `canvas_excalidraw_upgrade_${process.pid}_${Date.now()}`;
  const options = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const admin = postgres({ ...options, database: 'postgres' }); await admin.unsafe(`CREATE DATABASE ${name}`); await admin.end();
  const db = postgres({ ...options, database: name });
  try {
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    // Recreate the deployed shape: unnamed four-type CHECK, no pin check, no summary column.
    await db.unsafe(`ALTER TABLE flightdeck_pg_canvas_naplets DROP CONSTRAINT flightdeck_pg_canvas_naplets_source_type_check`);
    await db.unsafe(`ALTER TABLE flightdeck_pg_canvas_naplets DROP CONSTRAINT flightdeck_pg_canvas_naplets_version_pin_check`);
    await db.unsafe(`ALTER TABLE flightdeck_pg_canvas_naplets ADD CHECK (source_type IN ('document', 'task_list', 'chat_thread', 'html'))`);
    await db.unsafe(`ALTER TABLE flightdeck_pg_file_versions DROP COLUMN summary`);
    const [check] = await db`SELECT conname FROM pg_constraint WHERE conrelid = 'flightdeck_pg_canvas_naplets'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%chat_thread%'`;
    expect(check!.conname).toBe('flightdeck_pg_canvas_naplets_source_type_check');

    const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES('npub1excalidrawupgrade','human') RETURNING id`;
    const [workspace] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service','owner','app','Upgrade') RETURNING id`;
    const w = workspace!.id, a = actor!.id;
    await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${w},${a},'owner')`;
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${w},'S','project') RETURNING id`;
    const [channel] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${w},${scope!.id},'C') RETURNING id`;
    const [object] = await db`INSERT INTO v4_storage_objects(owner_npub, created_by_npub, file_name, content_type, size_bytes, storage_path) VALUES('owner','owner','f','text/html',1,'x') RETURNING id`;
    const [file] = await db`INSERT INTO flightdeck_pg_files(workspace_id,scope_id,channel_id,storage_object_id,created_by_actor_id,updated_by_actor_id) VALUES(${w},${scope!.id},${channel!.id},${object!.id},${a},${a}) RETURNING id`;
    const [version] = await db`INSERT INTO flightdeck_pg_file_versions(workspace_id,file_id,version_number,storage_object_id,created_by_actor_id) VALUES(${w},${file!.id},1,${object!.id},${a}) RETURNING id`;
    const [cvs] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${w},'C',1,${a},${a}) RETURNING id`;
    const [legacy] = await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,source_version_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${w},${cvs!.id},'html',${file!.id},${version!.id},'{}'::jsonb,${a},${a}) RETURNING *`;
    expect(await failure(db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${w},${cvs!.id},'excalidraw',${file!.id},'{}'::jsonb,${a},${a})`)).toMatch(/violates/);

    setDb(db); await ensureRuntimeSchema(); await ensureRuntimeSchema();
    expect((await db`SELECT * FROM flightdeck_pg_canvas_naplets WHERE id = ${legacy!.id}`)[0]).toEqual(legacy);
    expect((await db`SELECT summary FROM flightdeck_pg_file_versions WHERE id = ${version!.id}`)[0]).toEqual({ summary: null });
    await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${w},${cvs!.id},'excalidraw',${file!.id},'{}'::jsonb,${a},${a})`;
    await db`UPDATE flightdeck_pg_file_versions SET summary = 'ok' WHERE id = ${version!.id}`;
    expect(await failure(db`UPDATE flightdeck_pg_file_versions SET summary = ${'z'.repeat(281)} WHERE id = ${version!.id}`)).toMatch(/summary_check/);
    // The full bootstrap file is also re-runnable on the upgraded database (run-migrations path).
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
  } finally {
    await db.end();
    const cleanup = postgres({ ...options, database: 'postgres' }); await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name}`); await cleanup.end();
  }
}, 60000);
