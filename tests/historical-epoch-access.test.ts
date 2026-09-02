import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_epoch_access';

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

// --- Test identities ---
const ownerSecret = new Uint8Array(32).fill(21);
const aliceSecret = new Uint8Array(32).fill(22);
const bobSecret = new Uint8Array(32).fill(23);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const ALICE = nip19.npubEncode(getPublicKey(aliceSecret));
const BOB = nip19.npubEncode(getPublicKey(bobSecret));

const FAMILY = 'wp6_epoch_access_test';

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

// --- Helpers ---

async function createGroup(name: string, groupNpub: string, memberKeys: { member_npub: string; wrapped_group_nsec: string }[]) {
  const payload = {
    owner_npub: OWNER,
    name,
    group_npub: groupNpub,
    member_keys: memberKeys.map((mk) => ({ ...mk, wrapped_by_npub: OWNER })),
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
  return res.json();
}

async function addMember(groupId: string, memberNpub: string, wrappedKey: string) {
  const payload = {
    member_npub: memberNpub,
    wrapped_group_nsec: wrappedKey,
    wrapped_by_npub: OWNER,
  };
  const path = `/api/v4/groups/${groupId}/members`;
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(path, 'POST', ownerSecret, payload),
    },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function rotateGroup(groupId: string, newGroupNpub: string, memberKeys: { member_npub: string; wrapped_group_nsec: string }[]) {
  const path = `/api/v4/groups/${groupId}/rotate`;
  const payload = {
    group_npub: newGroupNpub,
    member_keys: memberKeys.map((mk) => ({ ...mk, wrapped_by_npub: OWNER })),
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
  return res.json();
}

async function removeMember(groupId: string, memberNpub: string) {
  const path = `/api/v4/groups/${groupId}/members/${memberNpub}`;
  const res = await app.request(path, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader(path, 'DELETE', ownerSecret),
    },
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function syncRecord(recordId: string, familyHash: string, version: number, previousVersion: number, groupPayloads?: any[]) {
  const payload = {
    owner_npub: OWNER,
    records: [
      {
        record_id: recordId,
        owner_npub: OWNER,
        record_family_hash: familyHash,
        version,
        previous_version: previousVersion,
        signature_npub: OWNER,
        owner_payload: { ciphertext: `owner_ct_${recordId}_v${version}` },
        ...(groupPayloads ? { group_payloads: groupPayloads } : {}),
      },
    ],
  };
  const res = await app.request('/api/v4/records/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
    },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function fetchRecords(viewerNpub: string, viewerSecret: Uint8Array, familyHash: string) {
  const path = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${viewerNpub}&record_family_hash=${familyHash}`;
  const res = await app.request(path, {
    headers: {
      Authorization: authHeader(path, 'GET', viewerSecret),
    },
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function fetchKeys(memberNpub: string, memberSecret: Uint8Array) {
  const path = `/api/v4/groups/keys?member_npub=${memberNpub}`;
  const res = await app.request(path, {
    headers: {
      Authorization: authHeader(path, 'GET', memberSecret),
    },
  });
  expect(res.status).toBe(200);
  return res.json();
}

// =============================================================================
// WP6: Historical Epoch Access Contract
// =============================================================================

describe('WP6: Historical Epoch Access Contract', () => {

  // ---------------------------------------------------------------------------
  // Scenario 1: New member added at current epoch cannot see prior-epoch records
  // ---------------------------------------------------------------------------
  describe('new member cannot access prior-epoch records', () => {
    let groupId: string;
    const EPOCH1_NPUB = 'npub1wp6_newmember_e1';
    const EPOCH2_NPUB = 'npub1wp6_newmember_e2';
    const FAMILY_NEW = `${FAMILY}_newmember`;

    test('setup: create group with owner+alice at epoch 1, share a record', async () => {
      const group = await createGroup('WP6 new-member test', EPOCH1_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6_e1_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6_e1_alice' },
      ]);
      groupId = group.group_id;

      const syncBody = await syncRecord('wp6-pre-rotation-rec', FAMILY_NEW, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'epoch1_content', write: false },
      ]);
      expect(syncBody.created).toBe(1);
    });

    test('alice can see the epoch-1 record before rotation', async () => {
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_NEW);
      expect(body.records.map((r: any) => r.record_id)).toContain('wp6-pre-rotation-rec');
    });

    test('rotate to epoch 2, add bob with epoch-2 key only', async () => {
      const rotateBody = await rotateGroup(groupId, EPOCH2_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6_e2_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6_e2_alice' },
        { member_npub: BOB, wrapped_group_nsec: 'wp6_e2_bob' },
      ]);
      expect(rotateBody.current_epoch).toBe(2);
    });

    test('bob receives only epoch-2 key, not epoch-1', async () => {
      const keysBody = await fetchKeys(BOB, bobSecret);
      const groupKeys = keysBody.keys.filter((k: any) => k.group_id === groupId);
      expect(groupKeys).toHaveLength(1);
      expect(groupKeys[0].key_version).toBe(2);
      expect(groupKeys[0].epoch).toBe(2);
    });

    test('bob CANNOT see the epoch-1 record (no historical key)', async () => {
      const body = await fetchRecords(BOB, bobSecret, FAMILY_NEW);
      expect(body.records.map((r: any) => r.record_id)).not.toContain('wp6-pre-rotation-rec');
    });

    test('bob CAN see a new record shared at epoch 2', async () => {
      await syncRecord('wp6-post-rotation-rec', FAMILY_NEW, 1, 0, [
        { group_id: groupId, group_epoch: 2, group_npub: EPOCH2_NPUB, ciphertext: 'epoch2_content', write: false },
      ]);
      const body = await fetchRecords(BOB, bobSecret, FAMILY_NEW);
      expect(body.records.map((r: any) => r.record_id)).toContain('wp6-post-rotation-rec');
    });

    test('alice still sees both epoch-1 and epoch-2 records (she has both keys)', async () => {
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_NEW);
      const ids = body.records.map((r: any) => r.record_id);
      expect(ids).toContain('wp6-pre-rotation-rec');
      expect(ids).toContain('wp6-post-rotation-rec');
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Reauthored content becomes visible to new members
  // ---------------------------------------------------------------------------
  describe('reauthored content becomes visible to new members', () => {
    let groupId: string;
    const EPOCH1_NPUB = 'npub1wp6_reauthor_e1';
    const EPOCH2_NPUB = 'npub1wp6_reauthor_e2';
    const FAMILY_RE = `${FAMILY}_reauthor`;

    test('setup: create group, share record at epoch 1, rotate, add bob at epoch 2', async () => {
      const group = await createGroup('WP6 reauthor test', EPOCH1_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6re_e1_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6re_e1_alice' },
      ]);
      groupId = group.group_id;

      await syncRecord('wp6-reauthor-rec', FAMILY_RE, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'original_epoch1', write: true },
      ]);

      await rotateGroup(groupId, EPOCH2_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6re_e2_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6re_e2_alice' },
        { member_npub: BOB, wrapped_group_nsec: 'wp6re_e2_bob' },
      ]);
    });

    test('bob cannot see the original epoch-1 record version', async () => {
      const body = await fetchRecords(BOB, bobSecret, FAMILY_RE);
      expect(body.records.map((r: any) => r.record_id)).not.toContain('wp6-reauthor-rec');
    });

    test('owner reauthors the record as v2 with epoch-2 group payload', async () => {
      const syncBody = await syncRecord('wp6-reauthor-rec', FAMILY_RE, 2, 1, [
        { group_id: groupId, group_epoch: 2, group_npub: EPOCH2_NPUB, ciphertext: 'reauthored_epoch2', write: true },
      ]);
      expect(syncBody.updated).toBe(1);
    });

    test('bob CAN now see the reauthored record (v2 uses epoch 2)', async () => {
      const body = await fetchRecords(BOB, bobSecret, FAMILY_RE);
      const rec = body.records.find((r: any) => r.record_id === 'wp6-reauthor-rec');
      expect(rec).toBeDefined();
      expect(rec.version).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Rotation-excluded member retains historical epoch access
  // ---------------------------------------------------------------------------
  describe('rotation-excluded member retains historical access', () => {
    let groupId: string;
    const EPOCH1_NPUB = 'npub1wp6_excluded_e1';
    const EPOCH2_NPUB = 'npub1wp6_excluded_e2';
    const FAMILY_EX = `${FAMILY}_excluded`;

    test('setup: create group with owner+alice, share record at epoch 1', async () => {
      const group = await createGroup('WP6 exclusion test', EPOCH1_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6ex_e1_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6ex_e1_alice' },
      ]);
      groupId = group.group_id;

      await syncRecord('wp6-excluded-rec', FAMILY_EX, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'epoch1_shared', write: false },
      ]);
    });

    test('alice sees epoch-1 record before rotation', async () => {
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_EX);
      expect(body.records.map((r: any) => r.record_id)).toContain('wp6-excluded-rec');
    });

    test('rotate to epoch 2 WITHOUT alice', async () => {
      const rotateBody = await rotateGroup(groupId, EPOCH2_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6ex_e2_owner' },
      ]);
      expect(rotateBody.current_epoch).toBe(2);
    });

    test('alice still sees epoch-1 record (her epoch-1 key was not revoked)', async () => {
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_EX);
      expect(body.records.map((r: any) => r.record_id)).toContain('wp6-excluded-rec');
    });

    test('alice CANNOT see new epoch-2 records (no epoch-2 key)', async () => {
      await syncRecord('wp6-excluded-epoch2-rec', FAMILY_EX, 1, 0, [
        { group_id: groupId, group_epoch: 2, group_npub: EPOCH2_NPUB, ciphertext: 'epoch2_only', write: false },
      ]);
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_EX);
      expect(body.records.map((r: any) => r.record_id)).not.toContain('wp6-excluded-epoch2-rec');
    });

    test('alice epoch-1 key is non-revoked, no epoch-2 key exists', async () => {
      const keysBody = await fetchKeys(ALICE, aliceSecret);
      const groupKeys = keysBody.keys.filter((k: any) => k.group_id === groupId);
      expect(groupKeys).toHaveLength(1);
      expect(groupKeys[0].key_version).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Explicit member removal revokes all keys
  // ---------------------------------------------------------------------------
  describe('explicit member removal revokes all epoch keys', () => {
    let groupId: string;
    const EPOCH1_NPUB = 'npub1wp6_removal_e1';
    const EPOCH2_NPUB = 'npub1wp6_removal_e2';
    const FAMILY_RM = `${FAMILY}_removal`;

    test('setup: group with owner+alice, records at epoch 1 and 2', async () => {
      const group = await createGroup('WP6 removal test', EPOCH1_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6rm_e1_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6rm_e1_alice' },
      ]);
      groupId = group.group_id;

      await syncRecord('wp6-removal-e1-rec', FAMILY_RM, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'e1_content', write: false },
      ]);

      await rotateGroup(groupId, EPOCH2_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6rm_e2_owner' },
        { member_npub: ALICE, wrapped_group_nsec: 'wp6rm_e2_alice' },
      ]);

      await syncRecord('wp6-removal-e2-rec', FAMILY_RM, 1, 0, [
        { group_id: groupId, group_epoch: 2, group_npub: EPOCH2_NPUB, ciphertext: 'e2_content', write: false },
      ]);
    });

    test('alice sees both epoch records before removal', async () => {
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_RM);
      const ids = body.records.map((r: any) => r.record_id);
      expect(ids).toContain('wp6-removal-e1-rec');
      expect(ids).toContain('wp6-removal-e2-rec');
    });

    test('explicitly remove alice from the group', async () => {
      const result = await removeMember(groupId, ALICE);
      expect(result.ok).toBe(true);
    });

    test('alice has zero non-revoked keys for this group after removal', async () => {
      const keysBody = await fetchKeys(ALICE, aliceSecret);
      const groupKeys = keysBody.keys.filter((k: any) => k.group_id === groupId);
      expect(groupKeys).toHaveLength(0);
    });

    test('alice CANNOT see any records after explicit removal (all keys revoked)', async () => {
      const body = await fetchRecords(ALICE, aliceSecret, FAMILY_RM);
      const ids = body.records.map((r: any) => r.record_id);
      expect(ids).not.toContain('wp6-removal-e1-rec');
      expect(ids).not.toContain('wp6-removal-e2-rec');
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Member added mid-epoch receives current epoch key_version
  // ---------------------------------------------------------------------------
  describe('member added mid-epoch gets key at current epoch version', () => {
    let groupId: string;
    const EPOCH1_NPUB = 'npub1wp6_midepoch_e1';
    const FAMILY_MID = `${FAMILY}_midepoch`;

    test('create group at epoch 1 with owner only, then add bob', async () => {
      const group = await createGroup('WP6 mid-epoch add', EPOCH1_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6mid_e1_owner' },
      ]);
      groupId = group.group_id;

      const addResult = await addMember(groupId, BOB, 'wp6mid_e1_bob');
      expect(addResult.key_version).toBe(1);
    });

    test('bob can see records shared at current epoch after mid-epoch add', async () => {
      await syncRecord('wp6-midepoch-rec', FAMILY_MID, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'mid_add_content', write: false },
      ]);
      const body = await fetchRecords(BOB, bobSecret, FAMILY_MID);
      expect(body.records.map((r: any) => r.record_id)).toContain('wp6-midepoch-rec');
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Multiple epoch gaps — member added at epoch 3 sees nothing before
  // ---------------------------------------------------------------------------
  describe('multi-epoch gap: member added at epoch 3 has no access to epochs 1 or 2', () => {
    let groupId: string;
    const E1 = 'npub1wp6_gap_e1';
    const E2 = 'npub1wp6_gap_e2';
    const E3 = 'npub1wp6_gap_e3';
    const FAMILY_GAP = `${FAMILY}_gap`;

    test('setup: create group, share records at epochs 1 and 2, add bob at epoch 3', async () => {
      const group = await createGroup('WP6 gap test', E1, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6gap_e1_owner' },
      ]);
      groupId = group.group_id;

      await syncRecord('wp6-gap-e1-rec', FAMILY_GAP, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: E1, ciphertext: 'gap_e1', write: false },
      ]);

      await rotateGroup(groupId, E2, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6gap_e2_owner' },
      ]);

      await syncRecord('wp6-gap-e2-rec', FAMILY_GAP, 1, 0, [
        { group_id: groupId, group_epoch: 2, group_npub: E2, ciphertext: 'gap_e2', write: false },
      ]);

      await rotateGroup(groupId, E3, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6gap_e3_owner' },
        { member_npub: BOB, wrapped_group_nsec: 'wp6gap_e3_bob' },
      ]);

      await syncRecord('wp6-gap-e3-rec', FAMILY_GAP, 1, 0, [
        { group_id: groupId, group_epoch: 3, group_npub: E3, ciphertext: 'gap_e3', write: false },
      ]);
    });

    test('bob cannot see epoch-1 or epoch-2 records', async () => {
      const body = await fetchRecords(BOB, bobSecret, FAMILY_GAP);
      const ids = body.records.map((r: any) => r.record_id);
      expect(ids).not.toContain('wp6-gap-e1-rec');
      expect(ids).not.toContain('wp6-gap-e2-rec');
    });

    test('bob can see epoch-3 record', async () => {
      const body = await fetchRecords(BOB, bobSecret, FAMILY_GAP);
      expect(body.records.map((r: any) => r.record_id)).toContain('wp6-gap-e3-rec');
    });

    test('bob has exactly one key at version 3', async () => {
      const keysBody = await fetchKeys(BOB, bobSecret);
      const groupKeys = keysBody.keys.filter((k: any) => k.group_id === groupId);
      expect(groupKeys).toHaveLength(1);
      expect(groupKeys[0].key_version).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Record version update does not retroactively grant access
  // ---------------------------------------------------------------------------
  describe('updating record version without re-sharing does not grant access', () => {
    let groupId: string;
    const EPOCH1_NPUB = 'npub1wp6_noretroaccess_e1';
    const EPOCH2_NPUB = 'npub1wp6_noretroaccess_e2';
    const FAMILY_NR = `${FAMILY}_noretro`;

    test('setup: group with owner, record at epoch 1, rotate, add bob at epoch 2', async () => {
      const group = await createGroup('WP6 no-retro test', EPOCH1_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6nr_e1_owner' },
      ]);
      groupId = group.group_id;

      await syncRecord('wp6-noretro-rec', FAMILY_NR, 1, 0, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'original', write: true },
      ]);

      await rotateGroup(groupId, EPOCH2_NPUB, [
        { member_npub: OWNER, wrapped_group_nsec: 'wp6nr_e2_owner' },
        { member_npub: BOB, wrapped_group_nsec: 'wp6nr_e2_bob' },
      ]);
    });

    test('owner updates record v2 but still uses epoch-1 group payload', async () => {
      const syncBody = await syncRecord('wp6-noretro-rec', FAMILY_NR, 2, 1, [
        { group_id: groupId, group_epoch: 1, group_npub: EPOCH1_NPUB, ciphertext: 'updated_still_e1', write: true },
      ]);
      expect(syncBody.updated).toBe(1);
    });

    test('bob still cannot see record because latest version payload is epoch 1', async () => {
      const body = await fetchRecords(BOB, bobSecret, FAMILY_NR);
      expect(body.records.map((r: any) => r.record_id)).not.toContain('wp6-noretro-rec');
    });
  });
});
