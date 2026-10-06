import { beforeAll, afterAll, describe, test, expect } from 'bun:test';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest, prepareStorageObjectForAuthorizedOwner, writeStorageObject, completeStorageObject, storageBlossomMetadata, backfillStorageHashes } from '../src/services/storage';
import { parseBlobRange } from '../src/routes/blossom';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';
const secret = new Uint8Array(32).fill(81);
const owner = nip19.npubEncode(getPublicKey(secret));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let sql: ReturnType<typeof postgres>;
const app = createApp();
function token(sha: string, overrides: { tags?: string[][]; expiry?: number; kind?: number; secret?: Uint8Array } = {}) {
  const event = finalizeEvent({ kind: overrides.kind || 24242, created_at: Math.floor(Date.now()/1000)-1, content: 'Read Tower file', tags: overrides.tags || [['t','get'], ['x',sha], ['expiration', String(overrides.expiry || Math.floor(Date.now()/1000)+120)]] }, overrides.secret || secret);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}`;
}
async function stored(bytes: Uint8Array, isPublic = true, type = 'application/octet-stream') {
  const row = await prepareStorageObjectForAuthorizedOwner({ owner_npub: owner, content_type: type, is_public: isPublic }, owner);
  await writeStorageObject(row.id, bytes, owner);
  return (await completeStorageObject(row.id, {}, owner))!;
}
beforeAll(async () => {
  const options = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), username: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' };
  const admin = postgres({ ...options, database: 'postgres' });
  await admin.unsafe('DROP DATABASE IF EXISTS tower_test_blossom');
  await admin.unsafe('CREATE DATABASE tower_test_blossom');
  await admin.end();
  sql = postgres({ ...options, database: 'tower_test_blossom' }); setDb(sql);
  for (const statement of splitSqlStatements(readFileSync(new URL('../src/schema/001_init.sql', import.meta.url), 'utf8'))) await sql.unsafe(statement);
  enableInMemoryStorageForTest();
});
afterAll(async () => { resetInMemoryStorageForTest(); if (sql) await sql.end(); });
describe('Blossom verified storage', () => {
  test('OpenAPI exposes retrieval and additive verified metadata without requiring public authentication', () => {
    const api = buildOpenApiDocument('http://localhost');
    expect(api.paths['/{sha256}'].get.security).toContainEqual({});
    expect(api.components.schemas.StorageObjectResponse.properties.blossom_url.type).toEqual(['string', 'null']);
    expect(api.components.securitySchemes.blossom.description).toContain('24242');
  });
  test('all MIME types, binary and empty bytes have matching GET/HEAD links', async () => {
    for (const [bytes, type] of [[new Uint8Array([0,255,1,80]), 'application/pdf'], [new Uint8Array(), 'text/plain'], [new Uint8Array([7,8]), 'video/mp4'], [new TextEncoder().encode('<script>alert(1)</script>'), 'text/html']] as const) {
      const row = await stored(bytes, true, type);
      const metadata = await storageBlossomMetadata(row, 'http://localhost');
      expect(metadata.blossom_url).toBe(`http://localhost/${hash(bytes)}`);
      const get = await app.request(`/${hash(bytes)}.anything`);
      expect(get.status).toBe(200); expect(get.headers.get('content-type')).toBe(type);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
      const head = await app.request(`/${hash(bytes)}`, { method: 'HEAD' });
      expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe(String(bytes.length)); expect(await head.text()).toBe('');
      expect(get.headers.get('access-control-allow-origin')).toBe('*');
      expect(get.headers.get('content-security-policy')).toContain('sandbox');
    }
  });
  test('ranges, If-Range and CORS preflight', async () => {
    const row = await stored(new Uint8Array([1,2,3,4,5])); const path = `/${row.sha256_hex}`;
    for (const [range, expected] of [['bytes=1-3',[2,3,4]], ['bytes=-2',[4,5]], ['bytes=3-',[4,5]]] as const) {
      const res = await app.request(path, { headers: { Range: range } }); expect(res.status).toBe(206); expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...expected]);
    }
    const bad = await app.request(path, { headers: { Range: 'bytes=10-20' } }); expect(bad.status).toBe(416); expect(bad.headers.get('content-range')).toBe('bytes */5');
    expect((await app.request(path, { headers: { Range: 'bytes=1-2', 'If-Range':'"different"' } })).status).toBe(200);
    const preflight = await app.request(path, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'HEAD', 'Access-Control-Request-Headers':'authorization,range' } });
    expect(preflight.headers.get('access-control-allow-methods')).toContain('HEAD');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(parseBlobRange('bytes=0-1,3-4',5)).toBe(false);
  });
  test('private hash does not grant access; BUD-11 signature, action, expiry, hash and server scopes are enforced', async () => {
    const row = await stored(new Uint8Array([40,41]), false); const path = `/${row.sha256_hex}`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request('/'+'0'.repeat(64))).status).toBe(401);
    expect((await app.request(path, { headers: { Authorization: token(row.sha256_hex!) } })).status).toBe(200);
    for (const invalid of [token('0'.repeat(64)), token(row.sha256_hex!, { expiry: 1 }), token(row.sha256_hex!, { tags: [['t','upload'], ['expiration','9999999999']] }), token(row.sha256_hex!, { tags: [['t','get'], ['server','other.example'], ['expiration','9999999999']] })]) expect((await app.request(path, { headers: { Authorization: invalid } })).status).toBe(401);
    expect((await app.request(path, { headers: { Authorization: token(row.sha256_hex!, { secret: new Uint8Array(32).fill(82) }) } })).status).toBe(404);
  });
  test('claims cannot poison identity; completed uploads are immutable through Tower', async () => {
    const row = await prepareStorageObjectForAuthorizedOwner({ owner_npub: owner, content_type:'text/plain' }, owner);
    await writeStorageObject(row.id, new Uint8Array([50]), owner);
    await expect(completeStorageObject(row.id, { sha256_hex:'0'.repeat(64) }, owner)).rejects.toThrow('mismatch');
    const complete = (await completeStorageObject(row.id, { size_bytes:999 }, owner))!;
    expect(Number(complete.size_bytes)).toBe(1); expect(complete.sha256_hex).toBe(hash(new Uint8Array([50])));
    expect(await writeStorageObject(row.id,new Uint8Array([51]),owner)).toBeNull();
  });
  test('bounded resumable backfill verifies historical claims; missing/incomplete/deleted objects have no links', async () => {
    const row = await stored(new Uint8Array([60,61,62]));
    await sql`UPDATE v4_storage_objects SET sha256_hex = ${'0'.repeat(64)}, sha256_verified_etag = NULL WHERE id=${row.id}`;
    const bounded = await backfillStorageHashes({ limit:1, maxBytes:2 }); expect(bounded.results[0].status).toBe('budget_exceeded');
    const filled = await backfillStorageHashes({ limit:1, maxBytes:3 }); expect(filled.results[0].status).toBe('verified'); expect(filled.next_cursor).toBe(row.id);
    expect((await app.request(`/${hash(new Uint8Array([60,61,62]))}`)).status).toBe(200);
    const missing = await prepareStorageObjectForAuthorizedOwner({ owner_npub:owner,content_type:'audio/webm' },owner);
    expect((await storageBlossomMetadata(missing,'http://localhost')).blossom_url).toBeNull();
    await sql`UPDATE v4_storage_objects SET completed_at=NOW() WHERE id=${missing.id}`;
    const result = await backfillStorageHashes({maxBytes:10}); expect(result.results.some(r=>r.id===missing.id && r.status==='missing')).toBe(true);
    await sql`DELETE FROM v4_storage_objects WHERE id=${row.id}`;
    expect((await app.request(`/${hash(new Uint8Array([60,61,62]))}`)).status).toBe(401);
  });
  test('duplicate hashes retain independent ownership and deletion', async () => {
    const bytes = new Uint8Array([70,71]); const first = await stored(bytes); const second = await stored(bytes);
    await sql`DELETE FROM v4_storage_objects WHERE id=${first.id}`;
    expect((await app.request(`/${hash(bytes)}`)).status).toBe(200);
    expect((await storageBlossomMetadata(second,'http://localhost')).blossom_url).not.toBeNull();
  });
});
