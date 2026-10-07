import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb, closeDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { createApp } from '../src/server';
import { collectWorkspaceStorageUsage, createStorageUsageCache, storedBytes, storageUsageSnapshot } from '../src/services/workspace-storage-usage';

const row = (bytes: number | null) => ({ id: 'objects', label: 'Objects', bytes, status: bytes === null ? 'unavailable' as const : 'partial' as const, measurement: bytes === null ? 'unavailable' as const : 'registered_bytes' as const, reason: 'Fixture coverage.' });
test('aggregation distinguishes unknown from measured zero and rejects invalid counts', () => {
  expect(storageUsageSnapshot('a', 'now', [row(null)]).total_bytes).toBeNull();
  expect(storageUsageSnapshot('a', 'now', [row(0), row(null)]).total_bytes).toBe(0);
  expect(storageUsageSnapshot('a', 'now', [row(12), row(5), row(null)]).total_bytes).toBe(17);
  for (const value of [null, undefined, -1, 'no', Number.MAX_SAFE_INTEGER + 1]) expect(() => storedBytes(value)).toThrow();
});
test('cache isolates UUIDs, coalesces, expires and caps concurrency', async () => {
  let clock = 0, calls = 0;
  const pending: Record<string, (value: any) => void> = {};
  const cache = createStorageUsageCache(id => { calls++; return new Promise(resolve => { pending[id] = resolve; }); }, () => clock);
  const a = cache('a'), same = cache('a'), b = cache('b');
  await expect(cache('c')).rejects.toThrow('storage_usage_busy');
  await Promise.resolve(); expect(calls).toBe(2);
  pending.a(storageUsageSnapshot('a', 'one', [row(7)])); pending.b(storageUsageSnapshot('b', 'one', [row(19)]));
  expect((await a).total_bytes).toBe(7); expect(await same).toEqual(await a); expect((await b).total_bytes).toBe(19);
  expect((await cache('a')).total_bytes).toBe(7); expect(calls).toBe(2);
  clock = 60_001; const fresh = cache('a'); await Promise.resolve();
  pending.a(storageUsageSnapshot('a', 'two', [row(10)])); expect((await fresh).collected_at).toBe('two');
});
test('failed catalog/provider is unavailable, never measured zero', async () => {
  const db = { begin: async () => { throw new Error('timeout'); } };
  const data = await collectWorkspaceStorageUsage('a', db as any);
  expect(data.total_bytes).toBeNull(); expect(data.categories).toHaveLength(6);
  expect(data.categories.every(item => item.bytes === null && item.reason)).toBe(true);
});

const port = Number(process.env.USAGE_TEST_PORT);
describe.skipIf(!port || port === 5432)('workspace storage usage on disposable PostgreSQL', () => {
  const conn = { host: '127.0.0.1', port, username: 'postgres', password: 'postgres', onnotice: () => {} };
  const database = `tower_usage_${process.pid}_${Date.now()}`;
  let db: ReturnType<typeof postgres>, a: string, b: string, actor: string, member: string;
  const ownerKey = new Uint8Array(32).fill(51), memberKey = new Uint8Array(32).fill(52), outsiderKey = new Uint8Array(32).fill(53);
  const npub = (key: Uint8Array) => nip19.npubEncode(getPublicKey(key));
  const app = createApp();
  beforeAll(async () => {
    const admin = postgres({ ...conn, database: 'postgres' }); await admin.unsafe(`CREATE DATABASE ${database}`); await admin.end();
    db = postgres({ ...conn, database }); setDb(db);
    for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await db.unsafe(statement);
    const [owner] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub(ownerKey)},'human') RETURNING id`; actor = owner!.id;
    const [reader] = await db`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${npub(memberKey)},'human') RETURNING id`; member = reader!.id;
    // Same human owner for both workspaces: owner npub is intentionally insufficient isolation.
    for (const id of [randomUUID(), randomUUID()]) {
      await db`INSERT INTO flightdeck_pg_workspaces(id,tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name)
        VALUES(${id},'tower',${id},${npub(ownerKey)},'usage-app','Usage fixture')`;
      await db`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role) VALUES(${id},${actor},'owner'),(${id},${member},'member')`;
      await db`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission)
        VALUES(${id},'actor',${actor},'workspace','workspace.manage')`;
      if (!a) a = id; else b = id;
    }
    const [scope] = await db`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind) VALUES(${a},'Usage','project') RETURNING id`;
    const [channel] = await db`INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name) VALUES(${a},${scope!.id},'Usage') RETURNING id`;
    const [object] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,completed_at)
      VALUES(${npub(ownerKey)},${npub(ownerKey)},'text/plain',1234,'fixture/one',NOW()) RETURNING id`;
    await db`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,entity_id,storage_object_id)
      VALUES(${a},${scope!.id},${channel!.id},'message',${randomUUID()},${object!.id})`;
    // Referencing the same physical object twice (including retained/deleted link) counts it once.
    await db`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,entity_id,storage_object_id,deleted_at)
      VALUES(${a},${scope!.id},${channel!.id},'message',${randomUUID()},${object!.id},NOW())`;
    // Unlinked and pending bytes must not be attributed to A by the shared human owner.
    const [pendingObject] = await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path)
      VALUES(${npub(ownerKey)},${npub(ownerKey)},'text/plain',9000,'fixture/pending') RETURNING id`;
    await db`INSERT INTO flightdeck_pg_storage_links(workspace_id,scope_id,channel_id,entity_type,entity_id,storage_object_id)
      VALUES(${a},${scope!.id},${channel!.id},'message',${randomUUID()},${pendingObject!.id})`;
    await db`INSERT INTO v4_storage_objects(owner_npub,created_by_npub,content_type,size_bytes,storage_path,completed_at)
      VALUES(${npub(ownerKey)},${npub(ownerKey)},'text/plain',8000,'fixture/unlinked',NOW())`;
  });
  afterAll(async () => { await closeDb(); });
  const route = (workspace: string) => `/api/v4/flightdeck-pg/workspaces/${workspace}/storage-usage`;
  function request(workspace: string, key = ownerKey) {
    const path = route(workspace), url = `http://localhost${path}`;
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now()/1000), content: '', tags: [['u',url],['method','GET']] }, key);
    return app.request(url, { headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'x-flightdeck-pg-app-npub': 'usage-app' } });
  }
  test('real SQL counts unique completed object paths and isolates same-owner workspaces', async () => {
    const dataA = await collectWorkspaceStorageUsage(a, db), dataB = await collectWorkspaceStorageUsage(b, db);
    expect(dataA.categories[0]!.bytes).toBe(1234); expect(dataB.categories[0]!.bytes).toBe(0);
    expect(dataA.categories[1]!.bytes).toBeGreaterThan(dataB.categories[1]!.bytes!);
    expect(dataA.categories[1]!.measurement).toBe('logical_estimate');
    expect(dataA.total_bytes).toBe(dataA.categories[0]!.bytes! + dataA.categories[1]!.bytes!);
    expect(dataA.coverage).toBe('partial');
    for (const item of dataA.categories.slice(2)) expect(item).toMatchObject({ bytes: null, status: 'unavailable' });
  });
  test('route authenticates and requires workspace.manage even after the cache warms', async () => {
    expect((await app.request(`http://localhost${route(a)}`)).status).toBe(401);
    expect((await request(a, outsiderKey)).status).toBe(403);
    expect((await request(a, memberKey)).status).toBe(403);
    const allowed = await request(a); expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('private, no-store');
    expect((await allowed.json()).workspace_id).toBe(a);
    expect((await request(a, memberKey)).status).toBe(403);
    await db`DELETE FROM flightdeck_pg_permission_grants WHERE workspace_id=${a} AND principal_actor_id=${actor} AND permission='workspace.manage'`;
    // Remove owner role as well: revocation must prevent access to cached totals.
    await db`UPDATE flightdeck_pg_workspace_memberships SET role='member' WHERE workspace_id=${a} AND actor_id=${actor}`;
    expect((await request(a)).status).toBe(403);
  });
});
