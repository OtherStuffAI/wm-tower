import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';

/**
 * WP8 Group Architecture Validation Suite — Tower
 *
 * End-to-end integration tests for the canonical group model across:
 * - Owner and non-owner reads
 * - Workspace-key owner-payload path (signer resolution)
 * - Delegated non-owner writes
 * - Rotation (epoch, npub, key_version)
 * - Member removal and addition
 * - Key revocation after removal
 * - Re-addition after removal at current epoch
 *
 * These tests exercise the full API surface through Hono's app.request(),
 * backed by a real Postgres test database.
 */

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_wp8_test';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

// Four distinct identities for testing
const ownerSecret = new Uint8Array(32).fill(10);
const memberASecret = new Uint8Array(32).fill(11);
const memberBSecret = new Uint8Array(32).fill(12);
const outsiderSecret = new Uint8Array(32).fill(13);

const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER_A = nip19.npubEncode(getPublicKey(memberASecret));
const MEMBER_B = nip19.npubEncode(getPublicKey(memberBSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));

async function createWorkspaceBaseline() {
  const payload = {
    workspace_owner_npub: OWNER,
    name: 'WP8 Workspace',
    description: 'Workspace bootstrap for canonical group validation',
    wrapped_workspace_nsec: 'wp8-workspace-wrapped',
    wrapped_by_npub: OWNER,
    default_group_npub: 'npub1wp8_workspace_default',
    default_group_name: 'WP8 Shared',
    default_group_member_keys: [
      { member_npub: OWNER, wrapped_group_nsec: 'wp8-default-owner', wrapped_by_npub: OWNER },
    ],
    admin_group_npub: 'npub1wp8_workspace_admin',
    admin_group_name: 'WP8 Admins',
    admin_group_member_keys: [
      { member_npub: OWNER, wrapped_group_nsec: 'wp8-admin-owner', wrapped_by_npub: OWNER },
    ],
    private_group_npub: 'npub1wp8_workspace_private',
    private_group_name: 'WP8 Private',
    private_group_member_keys: [
      { member_npub: OWNER, wrapped_group_nsec: 'wp8-private-owner', wrapped_by_npub: OWNER },
    ],
  };

  const res = await app.request('/api/v4/workspaces', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader('/api/v4/workspaces', 'POST', ownerSecret, payload),
    },
    body: JSON.stringify(payload),
  });

  if (res.status !== 201) {
    throw new Error(`WP8 workspace bootstrap failed: ${res.status} ${await res.text()}`);
  }
}

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

// -------------------------------------------------------------------------
// DB setup / teardown
// -------------------------------------------------------------------------

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
  await createWorkspaceBaseline();
});

afterAll(async () => {
  if (sql) await sql.end();
});

// =========================================================================
// Full lifecycle: create → add → rotate → remove → re-add
// =========================================================================

describe('WP8: Group lifecycle integration', () => {
  let groupId: string;
  const EPOCH_1_NPUB = 'npub1wp8_epoch1_test';
  const EPOCH_2_NPUB = 'npub1wp8_epoch2_test';
  const EPOCH_3_NPUB = 'npub1wp8_epoch3_test';

  // --- Phase 1: Creation ---

  test('create group with owner + memberA', async () => {
    const payload = {
      owner_npub: OWNER,
      name: 'WP8 Validation Group',
      group_npub: EPOCH_1_NPUB,
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wp8-owner-e1', wrapped_by_npub: OWNER },
        { member_npub: MEMBER_A, wrapped_group_nsec: 'wp8-memberA-e1', wrapped_by_npub: OWNER },
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
    expect(body.group_npub).toBe(EPOCH_1_NPUB);
    expect(body.members).toHaveLength(2);
    groupId = body.group_id;
  });

  // --- Phase 2: Owner reads ---

  test('owner lists group with correct membership', async () => {
    const path = `/api/v4/groups?npub=${OWNER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', ownerSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const group = body.groups.find((g: any) => g.id === groupId);
    expect(group).toBeDefined();
    expect(group.members).toContain(OWNER);
    expect(group.members).toContain(MEMBER_A);
    expect(group.members).not.toContain(MEMBER_B);
    expect(group.current_epoch).toBe(1);
  });

  // --- Phase 3: Non-owner reads ---

  test('memberA sees group in their list', async () => {
    const path = `/api/v4/groups?npub=${MEMBER_A}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberASecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const group = body.groups.find((g: any) => g.id === groupId);
    expect(group).toBeDefined();
    expect(group.group_npub).toBe(EPOCH_1_NPUB);
  });

  test('memberA fetches their wrapped keys for epoch 1', async () => {
    const path = `/api/v4/groups/keys?member_npub=${MEMBER_A}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberASecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const key = body.keys.find((k: any) => k.group_id === groupId);
    expect(key).toBeDefined();
    expect(key.group_npub).toBe(EPOCH_1_NPUB);
    expect(key.key_version).toBe(1);
    expect(key.epoch).toBe(1);
    expect(key.wrapped_group_nsec).toBe('wp8-memberA-e1');
  });

  test('outsider does not see the group', async () => {
    const path = `/api/v4/groups?npub=${OUTSIDER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', outsiderSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const group = body.groups.find((g: any) => g.id === groupId);
    expect(group).toBeUndefined();
  });

  test('outsider has no wrapped keys for this group', async () => {
    const path = `/api/v4/groups/keys?member_npub=${OUTSIDER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', outsiderSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const key = body.keys.find((k: any) => k.group_id === groupId);
    expect(key).toBeUndefined();
  });

  // --- Phase 4: Add memberB ---

  test('owner adds memberB at current epoch', async () => {
    const addPath = `/api/v4/groups/${groupId}/members`;
    const payload = {
      member_npub: MEMBER_B,
      wrapped_group_nsec: 'wp8-memberB-e1',
      wrapped_by_npub: OWNER,
    };
    const res = await app.request(addPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(addPath, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member_npub).toBe(MEMBER_B);
    expect(body.key_version).toBe(1); // current epoch is 1
  });

  test('memberB now sees the group', async () => {
    const path = `/api/v4/groups?npub=${MEMBER_B}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberBSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const group = body.groups.find((g: any) => g.id === groupId);
    expect(group).toBeDefined();
    expect(group.members).toContain(MEMBER_B);
  });

  // --- Phase 5: Rotation (epoch 1 → 2) ---

  test('rotate to epoch 2, including all 3 members', async () => {
    const rotatePath = `/api/v4/groups/${groupId}/rotate`;
    const payload = {
      group_npub: EPOCH_2_NPUB,
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wp8-owner-e2', wrapped_by_npub: OWNER },
        { member_npub: MEMBER_A, wrapped_group_nsec: 'wp8-memberA-e2', wrapped_by_npub: OWNER },
        { member_npub: MEMBER_B, wrapped_group_nsec: 'wp8-memberB-e2', wrapped_by_npub: OWNER },
      ],
    };
    const res = await app.request(rotatePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(rotatePath, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group_id).toBe(groupId);
    expect(body.group_npub).toBe(EPOCH_2_NPUB);
    expect(body.current_epoch).toBe(2);
  });

  test('group_npub updated after rotation', async () => {
    const path = `/api/v4/groups?npub=${OWNER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', ownerSecret) },
    });

    const body = await res.json();
    const group = body.groups.find((g: any) => g.id === groupId);
    expect(group.group_npub).toBe(EPOCH_2_NPUB);
  });

  test('memberA has keys for both epochs after rotation', async () => {
    const path = `/api/v4/groups/keys?member_npub=${MEMBER_A}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberASecret) },
    });

    const body = await res.json();
    const groupKeys = body.keys.filter((k: any) => k.group_id === groupId);
    expect(groupKeys).toHaveLength(2);

    const e1 = groupKeys.find((k: any) => k.epoch === 1);
    const e2 = groupKeys.find((k: any) => k.epoch === 2);
    expect(e1.group_npub).toBe(EPOCH_1_NPUB);
    expect(e1.wrapped_group_nsec).toBe('wp8-memberA-e1');
    expect(e2.group_npub).toBe(EPOCH_2_NPUB);
    expect(e2.wrapped_group_nsec).toBe('wp8-memberA-e2');
  });

  // --- Phase 6: Remove memberB ---

  test('owner removes memberB', async () => {
    const path = `/api/v4/groups/${groupId}/members/${MEMBER_B}`;
    const res = await app.request(path, {
      method: 'DELETE',
      headers: { Authorization: authHeader(path, 'DELETE', ownerSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.member_npub).toBe(MEMBER_B);
  });

  test('memberB keys are revoked after removal', async () => {
    const path = `/api/v4/groups/keys?member_npub=${MEMBER_B}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberBSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const groupKeys = body.keys.filter((k: any) => k.group_id === groupId);
    // getWrappedKeysForMember filters out revoked_at IS NOT NULL
    expect(groupKeys).toHaveLength(0);
  });

  test('memberB no longer listed in group members', async () => {
    const path = `/api/v4/groups?npub=${OWNER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', ownerSecret) },
    });

    const body = await res.json();
    const group = body.groups.find((g: any) => g.id === groupId);
    expect(group.members).not.toContain(MEMBER_B);
    expect(group.members).toContain(OWNER);
    expect(group.members).toContain(MEMBER_A);
  });

  // --- Phase 7: Rotate with memberB excluded (epoch 2 → 3) ---

  test('rotate to epoch 3, excluding memberB', async () => {
    const rotatePath = `/api/v4/groups/${groupId}/rotate`;
    const payload = {
      group_npub: EPOCH_3_NPUB,
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wp8-owner-e3', wrapped_by_npub: OWNER },
        { member_npub: MEMBER_A, wrapped_group_nsec: 'wp8-memberA-e3', wrapped_by_npub: OWNER },
      ],
    };
    const res = await app.request(rotatePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(rotatePath, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current_epoch).toBe(3);
    expect(body.group_npub).toBe(EPOCH_3_NPUB);
  });

  test('memberA has keys for all 3 epochs', async () => {
    const path = `/api/v4/groups/keys?member_npub=${MEMBER_A}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberASecret) },
    });

    const body = await res.json();
    const groupKeys = body.keys.filter((k: any) => k.group_id === groupId);
    expect(groupKeys).toHaveLength(3);
    expect(groupKeys.map((k: any) => k.epoch).sort()).toEqual([1, 2, 3]);
  });

  // --- Phase 8: Re-add memberB after rotation ---

  test('re-add memberB at current epoch 3', async () => {
    const addPath = `/api/v4/groups/${groupId}/members`;
    const payload = {
      member_npub: MEMBER_B,
      wrapped_group_nsec: 'wp8-memberB-e3-readded',
      wrapped_by_npub: OWNER,
    };
    const res = await app.request(addPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(addPath, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member_npub).toBe(MEMBER_B);
    expect(body.key_version).toBe(3); // aligned with current epoch
  });

  test('re-added memberB gets key only at epoch 3 (epochs 1-2 stay revoked)', async () => {
    const path = `/api/v4/groups/keys?member_npub=${MEMBER_B}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberBSecret) },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const groupKeys = body.keys.filter((k: any) => k.group_id === groupId);
    // Only epoch 3 key should be active (epochs 1-2 were revoked)
    expect(groupKeys).toHaveLength(1);
    expect(groupKeys[0].epoch).toBe(3);
    expect(groupKeys[0].wrapped_group_nsec).toBe('wp8-memberB-e3-readded');
  });
});

// =========================================================================
// Authorization boundary tests
// =========================================================================

describe('WP8: Authorization boundaries', () => {
  let groupId: string;

  test('setup: create a group for auth boundary tests', async () => {
    const payload = {
      owner_npub: OWNER,
      name: 'WP8 Auth Boundary',
      group_npub: 'npub1wp8_auth_boundary',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'auth-owner-key', wrapped_by_npub: OWNER },
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
    groupId = (await res.json()).group_id;
  });

  test('non-owner cannot add members', async () => {
    const path = `/api/v4/groups/${groupId}/members`;
    const payload = {
      member_npub: OUTSIDER,
      wrapped_group_nsec: 'hacked-key',
      wrapped_by_npub: MEMBER_A,
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', memberASecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
  });

  test('non-owner cannot rotate group', async () => {
    const path = `/api/v4/groups/${groupId}/rotate`;
    const payload = {
      group_npub: 'npub1hacker_rotation',
      member_keys: [
        { member_npub: MEMBER_A, wrapped_group_nsec: 'hacked', wrapped_by_npub: MEMBER_A },
      ],
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', memberASecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
  });

  test('non-owner cannot remove members', async () => {
    const path = `/api/v4/groups/${groupId}/members/${OWNER}`;
    const res = await app.request(path, {
      method: 'DELETE',
      headers: { Authorization: authHeader(path, 'DELETE', memberASecret) },
    });
    expect(res.status).toBe(403);
  });

  test('non-owner cannot delete group', async () => {
    const path = `/api/v4/groups/${groupId}`;
    const res = await app.request(path, {
      method: 'DELETE',
      headers: { Authorization: authHeader(path, 'DELETE', memberASecret) },
    });
    expect(res.status).toBe(403);
  });

  test('key fetch rejects auth mismatch (viewer claims different npub)', async () => {
    // MEMBER_A signs the request but asks for OWNER's keys
    const path = `/api/v4/groups/keys?member_npub=${OWNER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberASecret) },
    });
    expect(res.status).toBe(403);
  });

  test('group list rejects auth mismatch', async () => {
    const path = `/api/v4/groups?npub=${OWNER}`;
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', outsiderSecret) },
    });
    expect(res.status).toBe(403);
  });
});

// =========================================================================
// Rotation atomicity
// =========================================================================

describe('WP8: Rotation atomicity', () => {
  test('rotation with empty member_keys is rejected', async () => {
    // First create a group
    const createPayload = {
      owner_npub: OWNER,
      name: 'WP8 Rotation Atomicity',
      group_npub: 'npub1wp8_rot_atom',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'rot-atom-key', wrapped_by_npub: OWNER },
      ],
    };
    const createRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createPayload),
      },
      body: JSON.stringify(createPayload),
    });
    expect(createRes.status).toBe(201);
    const { group_id } = await createRes.json();

    // Rotate with empty member_keys
    const rotatePath = `/api/v4/groups/${group_id}/rotate`;
    const rotatePayload = {
      group_npub: 'npub1wp8_rot_atom_2',
      member_keys: [],
    };
    const rotateRes = await app.request(rotatePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(rotatePath, 'POST', ownerSecret, rotatePayload),
      },
      body: JSON.stringify(rotatePayload),
    });
    expect(rotateRes.status).toBe(400);
  });

  test('rotation with missing group_npub is rejected', async () => {
    const createPayload = {
      owner_npub: OWNER,
      name: 'WP8 Rotation Missing Npub',
      group_npub: 'npub1wp8_rot_missing',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'rot-missing-key', wrapped_by_npub: OWNER },
      ],
    };
    const createRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createPayload),
      },
      body: JSON.stringify(createPayload),
    });
    const { group_id } = await createRes.json();

    const rotatePath = `/api/v4/groups/${group_id}/rotate`;
    const rotatePayload = {
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'key', wrapped_by_npub: OWNER },
      ],
    };
    const rotateRes = await app.request(rotatePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(rotatePath, 'POST', ownerSecret, rotatePayload),
      },
      body: JSON.stringify(rotatePayload),
    });
    expect(rotateRes.status).toBe(400);
  });
});
