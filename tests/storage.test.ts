import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_storage';

let sql: ReturnType<typeof postgres>;
let app: any;

const ownerSecret = new Uint8Array(32).fill(21);
const memberSecret = new Uint8Array(32).fill(22);
const outsiderSecret = new Uint8Array(32).fill(23);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));

const WORKSPACE_NPUB = 'npub1workspace_storage_test_00001';
const GROUP_ID = '00000000-0000-0000-0000-000000000501';
const GROUP_NPUB = 'npub1group_storage_test_epoch1';
const RUN_S3_STORAGE_TESTS = /^(1|true|yes)$/i.test(process.env.RUN_TOWER_STORAGE_S3_TESTS || '');
const s3StorageTest = RUN_S3_STORAGE_TESTS ? test : test.skip;
let s3Available = false;
let s3AvailabilityChecked = false;

async function checkS3Availability(): Promise<boolean> {
  if (s3AvailabilityChecked) return s3Available;
  s3AvailabilityChecked = true;
  if (!RUN_S3_STORAGE_TESTS) {
    s3Available = false;
    return s3Available;
  }

  const endpoint = process.env.STORAGE_S3_ENDPOINT || 'http://127.0.0.1:9000';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(endpoint, { method: 'GET', signal: controller.signal });
      s3Available = true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    s3Available = false;
    // Keep this as a warning so full suite can stay green in environments without MinIO/S3.
    console.warn(`[storage.test] RUN_TOWER_STORAGE_S3_TESTS is enabled but STORAGE_S3_ENDPOINT is unreachable: ${endpoint}. Skipping S3-dependent storage tests.`);
  }
  return s3Available;
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: string) {
  const url = `http://localhost${path}`;
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  if (body !== undefined && method.toUpperCase() !== 'GET') {
    tags.push(['payload', sha256Hex(body)]);
  }

  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);

  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

beforeAll(async () => {
  process.env.STORAGE_S3_ENDPOINT = process.env.STORAGE_S3_ENDPOINT || 'http://127.0.0.1:9000';
  process.env.STORAGE_S3_REGION = process.env.STORAGE_S3_REGION || 'us-east-1';
  process.env.STORAGE_S3_ACCESS_KEY = process.env.STORAGE_S3_ACCESS_KEY || 'superbased';
  process.env.STORAGE_S3_SECRET_KEY = process.env.STORAGE_S3_SECRET_KEY || 'superbased-secret';
  process.env.STORAGE_S3_BUCKET = process.env.STORAGE_S3_BUCKET || 'superbased-storage';
  process.env.STORAGE_S3_FORCE_PATH_STYLE = process.env.STORAGE_S3_FORCE_PATH_STYLE || 'true';

  const adminOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOpts.password = process.env.DB_PASSWORD;

  const admin = postgres(adminOpts);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const testOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: TEST_DB,
  };
  if (process.env.DB_USER) testOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) testOpts.password = process.env.DB_PASSWORD;

  sql = postgres(testOpts);
  setDb(sql);

  const { readFileSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }

  // Set up workspace, group, and membership for tests
  await sql`
    INSERT INTO v4_groups (id, owner_npub, name, group_npub, group_kind)
    VALUES (${GROUP_ID}, ${WORKSPACE_NPUB}, 'Test Group', ${GROUP_NPUB}, 'shared')
  `;
  await sql`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
    VALUES (${GROUP_ID}, 1, ${GROUP_NPUB}, ${OWNER})
  `;
  await sql`
    INSERT INTO v4_workspaces (workspace_owner_npub, creator_npub, name, wrapped_workspace_nsec, wrapped_by_npub, default_group_id)
    VALUES (${WORKSPACE_NPUB}, ${OWNER}, 'Test Workspace', 'wrapped_nsec_test', ${OWNER}, ${GROUP_ID})
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES
      (${GROUP_ID}, ${OWNER}),
      (${GROUP_ID}, ${MEMBER})
  `;

  const serverModule = await import('../src/server');
  app = serverModule.createApp();
});

afterAll(async () => {
  if (sql) await sql.end();
});

describe('Storage API', () => {
  async function requireS3ForTest() {
    if (!await checkS3Availability()) return false;
    return true;
  }
  s3StorageTest('workspace owner can prepare, upload, complete, and fetch workspace-owned object', async () => {
    if (!await requireS3ForTest()) return;
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'audio/webm;codecs=opus',
      size_bytes: 4,
      file_name: 'note.webm',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();
    expect(prepared.object_id).toBeTruthy();
    expect(prepared.owner_group_id).toBeNull();
    expect(prepared.is_public).toBe(false);
    expect(prepared.content_url).toContain(`/api/v4/storage/${prepared.object_id}/content`);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({
      base64_data: Buffer.from(bytes).toString('base64'),
    });
    const uploadRes = await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', ownerSecret, uploadPayload),
      },
      body: uploadPayload,
    });
    expect(uploadRes.status).toBe(200);

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({
      sha256_hex: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
    const completeRes = await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', ownerSecret, completePayload),
      },
      body: completePayload,
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json();
    expect(completed.owner_group_id).toBeNull();

    const contentPath = `/api/v4/storage/${prepared.object_id}/content`;
    const contentRes = await app.request(contentPath, {
      headers: {
        Authorization: authHeader(contentPath, 'GET', ownerSecret),
      },
    });
    expect(contentRes.status).toBe(200);
    const fetched = new Uint8Array(await contentRes.arrayBuffer());
    expect(Array.from(fetched)).toEqual([1, 2, 3, 4]);
    expect(contentRes.headers.get('content-type')).toContain('audio/webm');
  });

  test('non-owner cannot prepare workspace-owned object', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'text/plain',
      file_name: 'unauthorized.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', memberSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(403);
    const body = await prepareRes.json();
    expect(body.error).toContain('workspace owner');
  });

  s3StorageTest('group member can prepare and upload group-owned object', async () => {
    if (!await requireS3ForTest()) return;
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'image/png',
      size_bytes: 3,
      file_name: 'group-avatar.png',
      access_group_ids: [GROUP_ID],
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', memberSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();
    expect(prepared.owner_group_id).toBe(GROUP_ID);
    expect(prepared.access_group_ids).toEqual([GROUP_ID]);

    const bytes = new Uint8Array([10, 20, 30]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({
      base64_data: Buffer.from(bytes).toString('base64'),
    });
    const uploadRes = await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', memberSecret, uploadPayload),
      },
      body: uploadPayload,
    });
    expect(uploadRes.status).toBe(200);

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({
      sha256_hex: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
    const completeRes = await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', memberSecret, completePayload),
      },
      body: completePayload,
    });
    expect(completeRes.status).toBe(200);
  });

  test('non-group-member cannot prepare group-owned object', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'text/plain',
      file_name: 'outsider.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', outsiderSecret, preparePayload),
      },
      body: preparePayload,
    });

    expect(prepareRes.status).toBe(403);
    const body = await prepareRes.json();
    expect(body.error).toContain('not a member');
  });

  s3StorageTest('group member can read object via access_group_ids', async () => {
    if (!await requireS3ForTest()) return;
    // Owner creates a group-owned object with access_group_ids
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'text/plain',
      size_bytes: 5,
      file_name: 'shared.txt',
      access_group_ids: [GROUP_ID],
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();

    const bytes = new Uint8Array([5, 4, 3, 2, 1]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({ base64_data: Buffer.from(bytes).toString('base64') });
    await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', ownerSecret, uploadPayload),
      },
      body: uploadPayload,
    });

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({ sha256_hex: sha256Hex(bytes), size_bytes: bytes.byteLength });
    await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', ownerSecret, completePayload),
      },
      body: completePayload,
    });

    // Member reads via group membership
    const contentPath = `/api/v4/storage/${prepared.object_id}/content`;
    const contentRes = await app.request(contentPath, {
      headers: {
        Authorization: authHeader(contentPath, 'GET', memberSecret),
      },
    });
    expect(contentRes.status).toBe(200);
    const fetched = new Uint8Array(await contentRes.arrayBuffer());
    expect(Array.from(fetched)).toEqual([5, 4, 3, 2, 1]);

    // Outsider cannot read
    const outsiderRes = await app.request(contentPath, {
      headers: {
        Authorization: authHeader(contentPath, 'GET', outsiderSecret),
      },
    });
    expect(outsiderRes.status).toBe(404);
  });

  s3StorageTest('public objects are accessible without auth', async () => {
    if (!await requireS3ForTest()) return;
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'image/png',
      size_bytes: 2,
      file_name: 'avatar.png',
      is_public: true,
      access_group_ids: [GROUP_ID],
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();
    expect(prepared.is_public).toBe(true);

    const bytes = new Uint8Array([0xff, 0xd8]);
    const uploadPath = `/api/v4/storage/${prepared.object_id}`;
    const uploadPayload = JSON.stringify({ base64_data: Buffer.from(bytes).toString('base64') });
    await app.request(uploadPath, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(uploadPath, 'PUT', ownerSecret, uploadPayload),
      },
      body: uploadPayload,
    });

    const completePath = `/api/v4/storage/${prepared.object_id}/complete`;
    const completePayload = JSON.stringify({ sha256_hex: sha256Hex(bytes), size_bytes: bytes.byteLength });
    await app.request(completePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(completePath, 'POST', ownerSecret, completePayload),
      },
      body: completePayload,
    });

    // Access metadata without auth
    const metadataPath = `/api/v4/storage/${prepared.object_id}`;
    const metadataRes = await app.request(metadataPath);
    expect(metadataRes.status).toBe(200);
    const metadata = await metadataRes.json();
    expect(metadata.is_public).toBe(true);

    // Access content without auth
    const contentPath = `/api/v4/storage/${prepared.object_id}/content`;
    const contentRes = await app.request(contentPath);
    expect(contentRes.status).toBe(200);
    const fetched = new Uint8Array(await contentRes.arrayBuffer());
    expect(Array.from(fetched)).toEqual([0xff, 0xd8]);
    expect(contentRes.headers.get('cache-control')).toContain('public');

    // Download URL without auth
    const downloadUrlPath = `/api/v4/storage/${prepared.object_id}/download-url`;
    const downloadUrlRes = await app.request(downloadUrlPath);
    expect(downloadUrlRes.status).toBe(200);
  });

  test('S3 path includes group UUID for group-owned objects', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      owner_group_id: GROUP_ID,
      content_type: 'text/plain',
      file_name: 'path-test.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();

    // Verify storage path in DB
    const [row] = await sql`SELECT storage_path FROM v4_storage_objects WHERE id = ${prepared.object_id}`;
    expect(row.storage_path).toContain(`v4/${WORKSPACE_NPUB}/${GROUP_ID}/`);
    expect(row.storage_path).toContain('path-test.txt');
  });

  test('S3 path does not include group UUID for workspace-owned objects', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: WORKSPACE_NPUB,
      content_type: 'text/plain',
      file_name: 'ws-path-test.txt',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(200);
    const prepared = await prepareRes.json();

    const [row] = await sql`SELECT storage_path FROM v4_storage_objects WHERE id = ${prepared.object_id}`;
    expect(row.storage_path).toMatch(new RegExp(`^v4/${WORKSPACE_NPUB}/[^/]+-ws-path-test.txt$`));
  });

  test('prepare rejects invalid owner_npub (no matching workspace)', async () => {
    const preparePayload = JSON.stringify({
      owner_npub: 'npub1nonexistent',
      content_type: 'text/plain',
    });

    const prepareRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, preparePayload),
      },
      body: preparePayload,
    });
    expect(prepareRes.status).toBe(403);
  });
});
