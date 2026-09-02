import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
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

  app = createApp();
});

afterAll(async () => {
  if (sql) await sql.end();
});

const ownerSecret = new Uint8Array(32).fill(1);
const botSecret = new Uint8Array(32).fill(2);
const outsiderSecret = new Uint8Array(32).fill(3);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const BOT = nip19.npubEncode(getPublicKey(botSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));
const GROUP_NPUB = 'npub1groupidentity_test_abc123';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: unknown) {
  const url = `http://localhost${path}`;
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  if (body !== undefined) {
    tags.push(['payload', sha256Hex(JSON.stringify(body))]);
  }

  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);

  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

describe('Groups API', () => {
  let groupId: string;

  test('POST /api/v4/groups - direct owner can create a group without a workspace row', async () => {
    const [workspaceCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM v4_workspaces
      WHERE workspace_owner_npub = ${OWNER}
    `;
    expect(Number(workspaceCount?.count || 0)).toBe(0);

    const payload = {
      owner_npub: OWNER,
      name: 'Operator + automation-agent',
      group_npub: GROUP_NPUB,
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'nip44_wrapped_key_for_owner',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: BOT,
          wrapped_group_nsec: 'nip44_wrapped_key_for_bot',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.group_id).toBeDefined();
    expect(body.group_npub).toBe(GROUP_NPUB);
    expect(body.owner_npub).toBe(OWNER);
    expect(body.name).toBe('Operator + automation-agent');
    expect(body.members).toHaveLength(2);
    groupId = body.group_id;
  });

  test('POST /api/v4/groups - rejects missing group_npub', async () => {
    const payload = {
      owner_npub: OWNER,
      name: 'No group npub',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'key', wrapped_by_npub: OWNER },
      ],
    };
    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/v4/groups - rejects empty member_keys', async () => {
    const payload = {
      owner_npub: OWNER,
      name: 'Empty keys',
      group_npub: 'npub1empty_keys_test',
      member_keys: [],
    };
    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/v4/groups - rejects when owner key missing from member_keys', async () => {
    const payload = {
      owner_npub: OWNER,
      name: 'No owner key',
      group_npub: 'npub1no_owner_key_test',
      member_keys: [
        { member_npub: BOT, wrapped_group_nsec: 'key', wrapped_by_npub: OWNER },
      ],
    };
    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('group creator must have a wrapped key');
  });

  test('POST /api/v4/groups/:groupId/members - add a member with wrapped key', async () => {
    const payload = {
      member_npub: OUTSIDER,
      wrapped_group_nsec: 'nip44_wrapped_key_for_outsider',
      wrapped_by_npub: OWNER,
    };
    const res = await app.request(`/api/v4/groups/${groupId}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(`/api/v4/groups/${groupId}/members`, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member_npub).toBe(OUTSIDER);
    expect(body.group_id).toBe(groupId);
    expect(body.wrapped_group_nsec).toBe('nip44_wrapped_key_for_outsider');
    expect(body.wrapped_by_npub).toBe(OWNER);
    expect(body.approved_by_npub).toBe(OWNER);
    expect(body.key_version).toBe(1);
  });

  test('POST /api/v4/groups/:groupId/members - non-owner cannot add member', async () => {
    const payload = {
      member_npub: 'npub1someone',
      wrapped_group_nsec: 'some_key',
      wrapped_by_npub: BOT,
    };
    const res = await app.request(`/api/v4/groups/${groupId}/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(`/api/v4/groups/${groupId}/members`, 'POST', botSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
  });

  test('POST /api/v4/groups/:groupId/members - 404 for missing group', async () => {
    const payload = {
      member_npub: 'npub1whatever',
      wrapped_group_nsec: 'some_key',
      wrapped_by_npub: OWNER,
    };
    const res = await app.request('/api/v4/groups/00000000-0000-0000-0000-000000000000/members', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups/00000000-0000-0000-0000-000000000000/members', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(404);
  });

  test('GET /api/v4/groups/keys - fetch wrapped keys for authenticated member', async () => {
    const path = `/api/v4/groups/keys?member_npub=${BOT}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', botSecret),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toBeDefined();
    expect(body.keys.length).toBeGreaterThanOrEqual(1);

    const key = body.keys.find((k: any) => k.group_id === groupId);
    expect(key).toBeDefined();
    expect(key.group_npub).toBe(GROUP_NPUB);
    expect(key.name).toBe('Operator + automation-agent');
    expect(key.wrapped_group_nsec).toBe('nip44_wrapped_key_for_bot');
    expect(key.wrapped_by_npub).toBe(OWNER);
    expect(key.approved_by_npub).toBe(OWNER);
    expect(key.key_version).toBe(1);
  });

  test('GET /api/v4/groups/keys - rejects mismatched auth', async () => {
    const path = `/api/v4/groups/keys?member_npub=${BOT}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(res.status).toBe(403);
  });

  test('GET /api/v4/groups - list includes membership groups, not just owned', async () => {
    // BOT is a member but not owner
    const path = `/api/v4/groups?npub=${BOT}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', botSecret),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups.length).toBeGreaterThanOrEqual(1);
    const g = body.groups.find((g: any) => g.id === groupId);
    expect(g).toBeDefined();
    expect(g.group_npub).toBe(GROUP_NPUB);
    expect(g.members).toContain(OWNER);
    expect(g.members).toContain(BOT);
  });

  test('POST /api/v4/groups/:groupId/rotate - rotates to a new epoch and npub', async () => {
    const path = `/api/v4/groups/${groupId}/rotate`;
    const payload = {
      group_npub: 'npub1group_rotated_epoch_test',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'rotated-owner-key', wrapped_by_npub: OWNER },
        { member_npub: BOT, wrapped_group_nsec: 'rotated-bot-key', wrapped_by_npub: OWNER },
        { member_npub: OUTSIDER, wrapped_group_nsec: 'rotated-outsider-key', wrapped_by_npub: OWNER },
      ],
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group_id).toBe(groupId);
    expect(body.group_npub).toBe(payload.group_npub);
    expect(body.current_epoch).toBe(2);

    const keysPath = `/api/v4/groups/keys?member_npub=${BOT}`;
    const keysRes = await app.request(keysPath, {
      headers: {
        Authorization: authHeader(keysPath, 'GET', botSecret),
      },
    });
    expect(keysRes.status).toBe(200);
    const keysBody = await keysRes.json();
    expect(keysBody.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_id: groupId, group_npub: GROUP_NPUB, key_version: 1, epoch: 1 }),
        expect.objectContaining({ group_id: groupId, group_npub: payload.group_npub, key_version: 2, epoch: 2 }),
      ])
    );
  });

  test('DELETE /api/v4/groups/:groupId/members/:memberNpub - remove a member', async () => {
    const path = `/api/v4/groups/${groupId}/members/${OUTSIDER}`;
    const res = await app.request(path, {
      method: 'DELETE',
      headers: {
        Authorization: authHeader(path, 'DELETE', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.group_id).toBe(groupId);
    expect(body.member_npub).toBe(OUTSIDER);

    const ownerListPath = `/api/v4/groups?npub=${OWNER}`;
    const ownerListRes = await app.request(ownerListPath, {
      headers: {
        Authorization: authHeader(ownerListPath, 'GET', ownerSecret),
      },
    });
    expect(ownerListRes.status).toBe(200);
    const ownerList = await ownerListRes.json();
    expect(ownerList.groups[0].members).not.toContain(OUTSIDER);

    const removedMemberKeysPath = `/api/v4/groups/keys?member_npub=${OUTSIDER}`;
    const removedMemberKeysRes = await app.request(removedMemberKeysPath, {
      headers: {
        Authorization: authHeader(removedMemberKeysPath, 'GET', outsiderSecret),
      },
    });
    expect(removedMemberKeysRes.status).toBe(200);
    const removedMemberKeys = await removedMemberKeysRes.json();
    expect(removedMemberKeys.keys.find((k: any) => k.group_id === groupId)).toBeUndefined();
  });

  test('GET /api/v4/groups - owner sees their groups', async () => {
    const path = `/api/v4/groups?npub=${OWNER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].members).toContain(OWNER);
    expect(body.groups[0].members).toContain(BOT);
    expect(body.groups[0].members).not.toContain(OUTSIDER);
  });

  test('GET /api/v4/groups - requires npub param', async () => {
    const res = await app.request('/api/v4/groups', {
      headers: {
        Authorization: authHeader('/api/v4/groups', 'GET', ownerSecret),
      },
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/v4/groups - rejects mismatched auth', async () => {
    const path = `/api/v4/groups?npub=${OWNER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', outsiderSecret),
      },
    });
    expect(res.status).toBe(403);
  });

  test('PATCH /api/v4/groups/:groupId - rename a group', async () => {
    const path = `/api/v4/groups/${groupId}`;
    const payload = { name: 'Automation Agent' };
    const res = await app.request(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'PATCH', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group_id).toBe(groupId);
    expect(body.name).toBe('Automation Agent');
  });

  test('DELETE /api/v4/groups/:groupId - delete a group', async () => {
    const path = `/api/v4/groups/${groupId}`;
    const res = await app.request(path, {
      method: 'DELETE',
      headers: {
        Authorization: authHeader(path, 'DELETE', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.group_id).toBe(groupId);

    const listPath = `/api/v4/groups?npub=${OWNER}`;
    const listRes = await app.request(listPath, {
      headers: {
        Authorization: authHeader(listPath, 'GET', ownerSecret),
      },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.groups).toHaveLength(0);
  });
});
