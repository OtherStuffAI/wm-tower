import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, writeStorageObject } from '../src/services/storage';
import { HTML_ARTIFACT_MAX_ASSET_BYTES } from '../src/services/flightdeck-pg-html-artifacts';

const port = Number(process.env.RECORD_TEST_PORT);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
// 1x1 transparent PNG.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

describe.skipIf(!port || port === 5432)('Private HTML artifact naplets signed API against disposable local Postgres', () => {
  const database = `canvas_html_artifacts_${process.pid}_${Date.now()}`;
  const connection = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  // 0 = owner/manager, 1 = reader of channel A only, 2 = workspace member without file access.
  const secrets = [121, 122, 123].map(n => new Uint8Array(32).fill(n));
  const npubs = secrets.map(secret => nip19.npubEncode(getPublicKey(secret)));
  let db: ReturnType<typeof postgres>, app: ReturnType<typeof createApp>;
  let workspace: string, canvas: string, channelA: string, channelB: string, actors: string[];

  async function request(path: string, method = 'GET', actor = 0, body?: unknown) {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', `http://localhost${path}`], ['method', method], ...(data ? [['payload', sha(encoder.encode(data))]] : [])] }, secrets[actor]!);
    const response = await app.request(path, { method, headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'Content-Type': 'application/json' }, body: data });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() as any : new Uint8Array(await response.arrayBuffer()) };
  }
  const ws = (suffix: string) => `/api/v4/flightdeck-pg/workspaces/${workspace}${suffix}`;
  const cv = (suffix: string) => ws(`/canvases/${canvas}${suffix}`);

  /** Store completed bytes in the workspace partition, optionally lying about size/digest. */
  async function storeObject(bytes: Uint8Array, contentType: string, overrides: { sha256?: string; size?: number } = {}) {
    const [row] = await db`
      INSERT INTO v4_storage_objects(owner_npub, created_by_npub, file_name, content_type, size_bytes, storage_path)
      VALUES (${npubs[0]!}, ${npubs[0]!}, 'object.bin', ${contentType}, ${bytes.byteLength}, ${`test/${crypto.randomUUID()}`}) RETURNING id`;
    expect(await writeStorageObject(row!.id, bytes, npubs[0]!)).not.toBeNull();
    await db`UPDATE v4_storage_objects SET completed_at = NOW(), sha256_hex = ${overrides.sha256 ?? sha(bytes)}, size_bytes = ${overrides.size ?? bytes.byteLength} WHERE id = ${row!.id}`;
    return row!.id as string;
  }
  async function createFile(channelId: string, bytes: Uint8Array, contentType: string, name: string, overrides = {}) {
    const objectId = await storeObject(bytes, contentType, overrides);
    const created = await request(ws(`/channels/${channelId}/files`), 'POST', 0, { storage_object_id: objectId, display_name: name });
    expect(created.status).toBe(201);
    const versions = await request(ws(`/files/${created.body.file.id}/versions`));
    return { fileId: created.body.file.id as string, versionId: versions.body.current_version_id as string };
  }
  async function publish(fileId: string, baseVersionId: string, bytes: Uint8Array, contentType = 'text/html') {
    const objectId = await storeObject(bytes, contentType);
    return request(ws(`/files/${fileId}/versions`), 'POST', 0, { base_version_id: baseVersionId, storage_object_id: objectId });
  }
  const manifestHtml = (body: string, assets: unknown[]) => encoder.encode(`<!doctype html><html><head><meta charset="utf-8"><title>Artifact</title><style>h1{color:#123}</style></head><body><h1>${body}</h1><img data-asset="a.png" alt="A"><img data-asset="b.png" alt="B"><script type="application/json" id="wingman-artifact-assets">${JSON.stringify({ version: 1, assets })}</script></body></html>`);

  beforeAll(async () => {
    enableInMemoryStorageForTest();
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...connection, database });
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    actors = [];
    for (const npub of npubs) {
      const [actor] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub},'human') RETURNING id`;
      actors.push(actor!.id);
    }
    const [row] = await db`INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name) VALUES('tower','service',${npubs[0]!},'app','Artifacts') RETURNING id`;
    workspace = row!.id;
    for (const [i, actor] of actors.entries()) await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${workspace},${actor},${i === 0 ? 'owner' : 'member'})`;
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${workspace},'Art','project') RETURNING id`;
    const [a] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope!.id},'Artifacts') RETURNING id`;
    const [b] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${workspace},${scope!.id},'Restricted') RETURNING id`;
    channelA = a!.id; channelB = b!.id;
    for (const channel of [channelA, channelB]) {
      for (const permission of ['file.read', 'file.write']) {
        await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[0]!},'channel',${channel},${permission})`;
      }
    }
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[1]!},'channel',${channelA},'file.read')`;
    const [c] = await db`INSERT INTO flightdeck_pg_canvases(workspace_id,title,position,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},'Artifacts',1,${actors[0]!},${actors[0]!}) RETURNING id`;
    canvas = c!.id;
    setDb(db); app = createApp();
  });
  afterAll(async () => {
    resetInMemoryStorageForTest();
    await db?.end();
    const admin = postgres({ ...connection, database: 'postgres' }); await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`); await admin.end();
  });

  test('follows latest, keeps legacy and explicit pins, browses versions and re-authorizes every asset', async () => {
    const imageA = await createFile(channelA, png, 'image/png', 'a.png');
    const imageB = await createFile(channelB, png, 'image/png', 'b.png');
    const v1Bytes = manifestHtml('Version one', [
      { name: 'a.png', file_id: imageA.fileId, version_id: imageA.versionId, sha256: sha(png) },
      { name: 'b.png', file_id: imageB.fileId, version_id: imageB.versionId, sha256: sha(png) },
    ]);
    const artifact = await createFile(channelA, v1Bytes, 'text/html', 'Daily catch-up');
    const layout = { x: 0, y: 0, width: 400, height: 300, z: 1 };

    const created = await request(cv('/naplets'), 'POST', 0, { source: { type: 'html', id: artifact.fileId }, layout });
    expect(created.status).toBe(201);
    expect(created.body.naplet.source).toEqual({ type: 'html', id: artifact.fileId, version_id: null });
    const latestId = created.body.naplet.id;

    // A naplet created by an older client stores the version id; it stays pinned.
    const legacy = await request(cv('/naplets'), 'POST', 0, { source: { type: 'html', id: artifact.versionId }, layout });
    expect(legacy.status).toBe(201);
    const [legacyRow] = await db`SELECT source_id, source_version_id FROM flightdeck_pg_canvas_naplets WHERE id = ${legacy.body.naplet.id}`;
    expect(legacyRow).toEqual({ source_id: artifact.fileId, source_version_id: artifact.versionId });
    const [rawLegacy] = await db`INSERT INTO flightdeck_pg_canvas_naplets(workspace_id,canvas_id,source_type,source_id,layout,created_by_actor_id,updated_by_actor_id) VALUES(${workspace},${canvas},'html',${artifact.versionId},${db.json(layout)},${actors[0]!},${actors[0]!}) RETURNING id`;

    // Reader of channel A: HTML plus only the channel A image.
    let snapshot = (await request(cv('/snapshot'), 'GET', 1)).body;
    const latest = snapshot.naplets.find((row: any) => row.id === latestId);
    expect(latest.access).toBe('ready');
    expect(latest.content).toMatchObject({ file_id: artifact.fileId, version_id: artifact.versionId, version_number: 1, current_version_number: 1, follows_latest: true, manifest_error: null });
    expect(latest.content.html).toContain('<head><meta charset="utf-8">');
    expect(latest.content.assets).toEqual([
      { name: 'a.png', status: 'ready', file_id: imageA.fileId, version_id: imageA.versionId, sha256: sha(png), size_bytes: png.byteLength, content_type: 'image/png' },
      { name: 'b.png', status: 'unavailable' },
    ]);
    expect(JSON.stringify(latest.content)).not.toMatch(/signed_url|download_url|storage_path|nsec/);
    const rawLegacyView = snapshot.naplets.find((row: any) => row.id === rawLegacy!.id);
    expect(rawLegacyView.source).toEqual({ type: 'html', id: artifact.fileId, version_id: artifact.versionId });
    expect(rawLegacyView.content.follows_latest).toBe(false);

    // Member without file.read: denied naplets, no browse, no bytes.
    const outsider = (await request(cv('/snapshot'), 'GET', 2)).body;
    for (const row of outsider.naplets) expect(Object.keys(row).sort()).toEqual(['access', 'id', 'layout', 'row_version']);
    expect((await request(cv(`/naplets/${latestId}/html`), 'GET', 2)).status).toBe(404);
    expect((await request(ws(`/files/${imageA.fileId}/versions/${imageA.versionId}/object`), 'GET', 2)).status).toBe(404);

    // Publishing uses base_version_id; a racing publisher with the old base loses.
    const v2Bytes = manifestHtml('Version two', [{ name: 'a.png', file_id: imageA.fileId, version_id: imageA.versionId, sha256: sha(png) }]);
    const v2 = await publish(artifact.fileId, artifact.versionId, v2Bytes);
    expect(v2.status).toBe(201);
    const v2Id = v2.body.version.id as string;
    expect((await publish(artifact.fileId, artifact.versionId, manifestHtml('Racer', []))).status).toBe(409);

    snapshot = (await request(cv('/snapshot'), 'GET', 1)).body;
    expect(snapshot.naplets.find((row: any) => row.id === latestId).content).toMatchObject({ version_id: v2Id, version_number: 2, current_version_number: 2, follows_latest: true });
    for (const id of [legacy.body.naplet.id, rawLegacy!.id]) {
      expect(snapshot.naplets.find((row: any) => row.id === id).content).toMatchObject({ version_id: artifact.versionId, version_number: 1, current_version_id: v2Id, current_version_number: 2, follows_latest: false });
    }

    // Viewer-local browsing does not change the naplet and lists the versions.
    const browsed = await request(cv(`/naplets/${latestId}/html?version_id=${artifact.versionId}`), 'GET', 1);
    expect(browsed.status).toBe(200);
    expect(browsed.body.content).toMatchObject({ version_id: artifact.versionId, version_number: 1, follows_latest: true });
    expect(browsed.body.versions.map((row: any) => row.version_number)).toEqual([2, 1]);
    expect((await request(cv(`/naplets/${latestId}/html?version_id=${imageA.versionId}`), 'GET', 1)).status).toBe(404);

    // Pin, reject foreign pins, then return to latest; CAS still applies.
    let row = (await request(cv('/snapshot'), 'GET', 0)).body.naplets.find((item: any) => item.id === latestId);
    expect((await request(cv(`/naplets/${latestId}`), 'PATCH', 0, { expected_row_version: row.row_version, source_version_id: imageA.versionId })).status).toBe(400);
    const pinned = await request(cv(`/naplets/${latestId}`), 'PATCH', 0, { expected_row_version: row.row_version, source_version_id: artifact.versionId });
    expect(pinned.status).toBe(200);
    expect(pinned.body.naplet.source.version_id).toBe(artifact.versionId);
    expect(pinned.body.naplet.content.version_number).toBe(1);
    expect((await request(cv(`/naplets/${latestId}`), 'PATCH', 0, { expected_row_version: row.row_version, source_version_id: null })).status).toBe(409);
    const followed = await request(cv(`/naplets/${latestId}`), 'PATCH', 0, { expected_row_version: pinned.body.naplet.row_version, source_version_id: null });
    expect(followed.body.naplet.content).toMatchObject({ version_number: 2, follows_latest: true });
    const legacyFollow = await request(cv(`/naplets/${rawLegacy!.id}`), 'PATCH', 0, { expected_row_version: 1, source_version_id: null });
    expect(legacyFollow.status).toBe(200);
    expect(await db`SELECT source_id, source_version_id FROM flightdeck_pg_canvas_naplets WHERE id = ${rawLegacy!.id}`).toEqual([{ source_id: artifact.fileId, source_version_id: null }]);
    row = (await request(cv('/snapshot'), 'GET', 0)).body.naplets.find((item: any) => item.id === latestId);
    expect((await request(cv(`/naplets/${latestId}`), 'PATCH', 1, { expected_row_version: row.row_version, source_version_id: null })).status).toBe(403);

    // Typed immutable version bytes: exact File/version, verified digest.
    const bytes = await request(ws(`/files/${imageA.fileId}/versions/${imageA.versionId}/object`), 'GET', 1);
    expect(bytes.status).toBe(200);
    expect(sha(bytes.body as Uint8Array)).toBe(sha(png));
    expect(bytes.headers.get('cache-control')).toMatch(/no-store/);
    expect(bytes.headers.get('etag')).toBe(`"${sha(png)}"`);
    expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bytes.headers.get('content-security-policy')).toContain('sandbox');
    expect((await request(ws(`/files/${imageB.fileId}/versions/${imageB.versionId}/object`), 'GET', 1)).status).toBe(404);
    expect((await request(ws(`/files/${imageA.fileId}/versions/${imageB.versionId}/object`), 'GET', 0)).status).toBe(404);

    // Revocation removes HTML and asset bytes on the next read.
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE principal_actor_id = ${actors[1]!}`;
    expect((await request(cv('/snapshot'), 'GET', 1)).body.naplets.every((item: any) => item.access === 'denied')).toBe(true);
    expect((await request(ws(`/files/${imageA.fileId}/versions/${imageA.versionId}/object`), 'GET', 1)).status).toBe(404);
    await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,resource_channel_id,permission) VALUES(${workspace},'actor',${actors[1]!},'channel',${channelA},'file.read')`;
  });

  test('rejects mismatched digests, oversize or non-image assets, foreign workspaces and tampered bytes', async () => {
    const good = await createFile(channelA, png, 'image/png', 'good.png');
    const svgBytes = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svg = await createFile(channelA, svgBytes, 'image/svg+xml', 'icon.svg');
    const text = await createFile(channelA, encoder.encode('plain'), 'text/plain', 'notes.txt');
    const huge = await createFile(channelA, png, 'image/png', 'huge.png', { size: HTML_ARTIFACT_MAX_ASSET_BYTES + 1 });
    const html = manifestHtml('Checks', [
      { name: 'good.png', file_id: good.fileId, version_id: good.versionId, sha256: sha(png) },
      { name: 'icon.svg', file_id: svg.fileId, version_id: svg.versionId, sha256: sha(svgBytes) },
      { name: 'wrong-hash.png', file_id: good.fileId, version_id: good.versionId, sha256: 'f'.repeat(64) },
      { name: 'notes.txt', file_id: text.fileId, version_id: text.versionId, sha256: sha(encoder.encode('plain')) },
      { name: 'huge.png', file_id: huge.fileId, version_id: huge.versionId, sha256: sha(png) },
      { name: 'swapped.png', file_id: svg.fileId, version_id: good.versionId, sha256: sha(png) },
    ]);
    const artifact = await createFile(channelA, html, 'text/html', 'Checks');
    const created = await request(cv('/naplets'), 'POST', 0, { source: { type: 'html', id: artifact.fileId }, layout: { x: 0, y: 0, width: 400, height: 300, z: 1 } });
    expect(created.body.naplet.content.assets.map((asset: any) => `${asset.name}:${asset.status}`)).toEqual([
      'good.png:ready', 'icon.svg:ready', 'wrong-hash.png:unavailable', 'notes.txt:unavailable', 'huge.png:unavailable', 'swapped.png:unavailable',
    ]);

    // Malformed manifests leave HTML readable with an explicit, non-sensitive error.
    const broken = await createFile(channelA, encoder.encode('<p>x</p><script type="application/json" id="wingman-artifact-assets">{nope</script>'), 'text/html', 'Broken');
    const brokenNaplet = await request(cv('/naplets'), 'POST', 0, { source: { type: 'html', id: broken.fileId }, layout: { x: 0, y: 0, width: 400, height: 300, z: 1 } });
    expect(brokenNaplet.body.naplet.content).toMatchObject({ assets: [], manifest_error: 'asset manifest is not valid JSON' });

    // Non-HTML Files cannot become HTML naplets.
    expect((await request(cv('/naplets'), 'POST', 0, { source: { type: 'html', id: good.fileId }, layout: { x: 0, y: 0, width: 400, height: 300, z: 1 } })).status).toBe(400);

    // Objects outside the workspace storage partition are never served.
    const foreign = await createFile(channelA, png, 'image/png', 'foreign.png');
    await db`UPDATE v4_storage_objects SET owner_npub = 'npub1someoneelse' WHERE id = (SELECT storage_object_id FROM flightdeck_pg_file_versions WHERE id = ${foreign.versionId})`;
    expect((await request(ws(`/files/${foreign.fileId}/versions/${foreign.versionId}/object`), 'GET', 0)).status).toBe(404);

    // Bytes that no longer match the recorded digest fail closed.
    const tampered = await createFile(channelA, png, 'image/png', 'tampered.png', { sha256: 'a'.repeat(64) });
    expect((await request(ws(`/files/${tampered.fileId}/versions/${tampered.versionId}/object`), 'GET', 0)).status).toBe(409);
  });
});
