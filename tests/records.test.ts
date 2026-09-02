import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { setRecordCheckoutPolicyOverridesForTests } from '../src/services/record-checkout-policy';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_records';

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

  // Run migrations
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
  setRecordCheckoutPolicyOverridesForTests(null);
  if (sql) await sql.end();
});

afterEach(() => {
  setRecordCheckoutPolicyOverridesForTests(null);
});

const ownerSecret = new Uint8Array(32).fill(11);
const memberSecret = new Uint8Array(32).fill(12);
const outsiderSecret = new Uint8Array(32).fill(13);
const groupSecret = new Uint8Array(32).fill(14);
const groupIdSecret = new Uint8Array(32).fill(15);
const strictLegacySecret = new Uint8Array(32).fill(16);
const ownerWsKeySecret = new Uint8Array(32).fill(17);
const memberWsKeySecret = new Uint8Array(32).fill(18);
const outsiderWsKeySecret = new Uint8Array(32).fill(19);
const checkoutWriteGroupSecret = new Uint8Array(32).fill(20);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));
const GROUP_WRITE_NPUB = nip19.npubEncode(getPublicKey(groupSecret));
const GROUP_ID_WRITE_NPUB = nip19.npubEncode(getPublicKey(groupIdSecret));
const STRICT_LEGACY_GROUP_NPUB = nip19.npubEncode(getPublicKey(strictLegacySecret));
const OWNER_WS_KEY = nip19.npubEncode(getPublicKey(ownerWsKeySecret));
const MEMBER_WS_KEY = nip19.npubEncode(getPublicKey(memberWsKeySecret));
const OUTSIDER_WS_KEY = nip19.npubEncode(getPublicKey(outsiderWsKeySecret));
const CHECKOUT_WRITE_GROUP_NPUB = nip19.npubEncode(getPublicKey(checkoutWriteGroupSecret));
const FAMILY_HASH = 'chat_channel_abc123';
const GROUP_NPUB = 'npub1group_test_xyz';
const RECORD_ID = 'rec-001-uuid';

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

async function ensureWorkspaceUserKeyBinding(userNpub: string, workspaceServiceNpub: string, workspaceUserKeyNpub: string) {
  await sql`
    INSERT INTO user_profiles (user_npub)
    VALUES (${userNpub})
    ON CONFLICT (user_npub) DO NOTHING
  `;
  await sql`
    INSERT INTO user_workspace_keys (user_npub, workspace_owner_npub, ws_key_npub, ws_key_epoch, active)
    VALUES (${userNpub}, ${workspaceServiceNpub}, ${workspaceUserKeyNpub}, 1, TRUE)
    ON CONFLICT (workspace_owner_npub, ws_key_npub) DO UPDATE
    SET user_npub = EXCLUDED.user_npub,
        active = TRUE
  `;
}

async function ensureWorkspaceReadableGroup(workspaceServiceNpub: string, memberNpub: string) {
  const groupNpub = `npub1checkoutread${crypto.randomUUID().replaceAll('-', '')}`;
  const [group] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
    VALUES (${workspaceServiceNpub}, ${'Checkout readable'}, ${groupNpub}, 'shared')
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${group.id}, ${memberNpub})
    ON CONFLICT (group_id, member_npub) DO NOTHING
  `;
}

async function createWritableCheckoutRecord(recordId: string, memberNpub: string, familyHash = 'coworker:document') {
  const groupNpub = CHECKOUT_WRITE_GROUP_NPUB;
  const [group] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
    VALUES (${OWNER}, ${`Checkout writable ${recordId}`}, ${groupNpub}, 'shared')
    ON CONFLICT (group_npub) DO UPDATE
    SET owner_npub = EXCLUDED.owner_npub
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
    VALUES (${group.id}, 1, ${groupNpub}, ${OWNER})
    ON CONFLICT (group_id, epoch) DO NOTHING
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${group.id}, ${memberNpub}), (${group.id}, ${OWNER})
    ON CONFLICT (group_id, member_npub) DO NOTHING
  `;
  const [record] = await sql<{ id: string }[]>`
    INSERT INTO v4_records (
      record_id,
      owner_npub,
      record_family_hash,
      version,
      previous_version,
      signature_npub,
      owner_ciphertext
    )
    VALUES (${recordId}, ${OWNER}, ${familyHash}, 1, 0, ${OWNER}, ${`${recordId}-v1`})
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_record_group_payloads (
      record_row_id,
      group_id,
      group_epoch,
      group_npub,
      ciphertext,
      can_write
    )
    VALUES (${record.id}, ${group.id}, 1, ${groupNpub}, ${`${recordId}-group-v1`}, TRUE)
  `;
  return { groupId: group.id, groupNpub };
}

async function createOwnerOnlyWritableCheckoutRecord(recordId: string, familyHash = 'coworker:document') {
  const groupNpub = `npub1checkoutowner${crypto.randomUUID().replaceAll('-', '')}`;
  const [group] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
    VALUES (${OWNER}, ${`Checkout owner only ${recordId}`}, ${groupNpub}, 'shared')
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
    VALUES (${group.id}, 1, ${groupNpub}, ${OWNER})
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${group.id}, ${OWNER})
    ON CONFLICT (group_id, member_npub) DO NOTHING
  `;
  const [record] = await sql<{ id: string }[]>`
    INSERT INTO v4_records (
      record_id,
      owner_npub,
      record_family_hash,
      version,
      previous_version,
      signature_npub,
      owner_ciphertext
    )
    VALUES (${recordId}, ${OWNER}, ${familyHash}, 1, 0, ${OWNER}, ${`${recordId}-v1`})
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_record_group_payloads (
      record_row_id,
      group_id,
      group_epoch,
      group_npub,
      ciphertext,
      can_write
    )
    VALUES (${record.id}, ${group.id}, 1, ${groupNpub}, ${`${recordId}-owner-group-v1`}, TRUE)
  `;
}

async function acquireCheckout(
  recordId: string,
  recordFamilyHash: string,
  userNpub: string,
  options: {
    workspaceServiceNpub?: string;
    workspaceUserKeyNpub?: string;
    secret?: Uint8Array;
    registerKey?: boolean;
    idempotencyKey?: string;
  } = {},
) {
  const workspaceServiceNpub = options.workspaceServiceNpub || OWNER;
  const workspaceUserKeyNpub = options.workspaceUserKeyNpub
    || (userNpub === OWNER ? OWNER_WS_KEY : userNpub === MEMBER ? MEMBER_WS_KEY : OUTSIDER_WS_KEY);
  const secret = options.secret
    || (userNpub === OWNER ? ownerWsKeySecret : userNpub === MEMBER ? memberWsKeySecret : outsiderWsKeySecret);
  if (options.registerKey !== false) {
    await ensureWorkspaceUserKeyBinding(userNpub, workspaceServiceNpub, workspaceUserKeyNpub);
  }
  const path = `/api/v4/records/${recordId}/checkout/acquire`;
  const payload = {
    workspace_service_npub: workspaceServiceNpub,
    user_npub: userNpub,
    workspace_user_key_npub: workspaceUserKeyNpub,
    record_family_hash: recordFamilyHash,
    lease_seconds: 900,
    idempotency_key: options.idempotencyKey || crypto.randomUUID(),
  };
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(path, 'POST', secret, payload),
    },
    body: JSON.stringify(payload),
  });
  return { res, payload };
}

describe('Records API', () => {
  test('POST /api/v4/records/sync - create new record (v1)', async () => {
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: RECORD_ID,
          owner_npub: OWNER,
          record_family_hash: FAMILY_HASH,
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'encrypted_hello_v1' },
          group_payloads: [
            {
              group_npub: GROUP_NPUB,
              ciphertext: 'group_encrypted_hello_v1',
              write: true,
            },
          ],
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
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.created).toBe(1);
    expect(body.updated).toBe(0);
    expect(body.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - accepts workspace_service_npub without owner_npub', async () => {
    const payload = {
      workspace_service_npub: OWNER,
      records: [
        {
          record_id: 'canonical-workspace-service-only',
          workspace_service_npub: OWNER,
          record_family_hash: 'identity:workspace_service_only',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'canonical_workspace_service_only' },
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
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.rejected).toHaveLength(0);

    const fetchPath = `/api/v4/records?workspace_service_npub=${OWNER}&record_family_hash=${encodeURIComponent('identity:workspace_service_only')}`;
    const fetchRes = await app.request(fetchPath, {
      headers: {
        Authorization: authHeader(fetchPath, 'GET', ownerSecret),
      },
    });
    expect(fetchRes.status).toBe(200);
    const fetchBody = await fetchRes.json();
    expect(fetchBody.audit.workspace_service_npub).toBe(OWNER);
    expect(fetchBody.records.some((record: any) => record.record_id === 'canonical-workspace-service-only')).toBe(true);
  });

  test('POST /api/v4/records/sync - accepts matching owner_npub and workspace_service_npub', async () => {
    const payload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      records: [
        {
          record_id: 'canonical-workspace-service-matching',
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'identity:workspace_service_matching',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'canonical_workspace_service_matching' },
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
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - rejects mismatched owner_npub and workspace_service_npub', async () => {
    const payload = {
      owner_npub: OWNER,
      workspace_service_npub: OUTSIDER,
      records: [],
    };
    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('identity_alias_mismatch');
    expect(body.error).toContain('owner_npub');
    expect(body.error).toContain('workspace_service_npub');
  });

  test('POST /api/v4/records/sync - update record (v2)', async () => {
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: RECORD_ID,
          owner_npub: OWNER,
          record_family_hash: FAMILY_HASH,
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'encrypted_hello_v2' },
          group_payloads: [
            {
              group_npub: GROUP_NPUB,
              ciphertext: 'group_encrypted_hello_v2',
              write: true,
            },
          ],
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
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.updated).toBe(1);
    expect(body.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - reject stale previous_version', async () => {
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: RECORD_ID,
          owner_npub: OWNER,
          record_family_hash: FAMILY_HASH,
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'stale_write' },
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
    const body = await res.json();
    expect(body.synced).toBe(0);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].record_id).toBe(RECORD_ID);
    expect(body.rejected[0].reason).toContain('version conflict');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - acquires and idempotently returns the same checkout to the same actor', async () => {
    const recordId = 'checkout-doc-001';
    const idempotencyKey = crypto.randomUUID();
    const first = await acquireCheckout(recordId, 'coworker:document', OWNER, { idempotencyKey });
    const firstRes = first.res;
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.checkout.state).toBe('checked_out');
    expect(firstBody.checkout.checked_out_by_user_npub).toBe(OWNER);

    const second = await acquireCheckout(recordId, 'coworker:document', OWNER, { idempotencyKey });
    const secondRes = second.res;
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.checkout.checkout_id).toBe(firstBody.checkout.checkout_id);
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - canonical field enforcement rejects missing workspace_service_npub', async () => {
    await ensureWorkspaceUserKeyBinding(OWNER, OWNER, OWNER_WS_KEY);
    const path = '/api/v4/records/checkout-doc-missing-workspace-service/checkout/acquire';
    const payload = {
      user_npub: OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
      record_family_hash: 'coworker:document',
      lease_seconds: 900,
      idempotency_key: crypto.randomUUID(),
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerWsKeySecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('workspace_service_npub required');
    expect(body.code).toBe('identity_alias_mismatch');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - canonical field enforcement rejects missing user_npub', async () => {
    await ensureWorkspaceUserKeyBinding(OWNER, OWNER, OWNER_WS_KEY);
    const path = '/api/v4/records/checkout-doc-missing-user/checkout/acquire';
    const payload = {
      workspace_service_npub: OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
      record_family_hash: 'coworker:document',
      lease_seconds: 900,
      idempotency_key: crypto.randomUUID(),
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerWsKeySecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('user_npub required');
    expect(body.code).toBe('identity_alias_mismatch');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - canonical field enforcement rejects missing workspace_user_key_npub', async () => {
    const path = '/api/v4/records/checkout-doc-missing-ws-key/checkout/acquire';
    const payload = {
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      record_family_hash: 'coworker:document',
      lease_seconds: 900,
      idempotency_key: crypto.randomUUID(),
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('workspace_user_key_npub required');
    expect(body.code).toBe('workspace_key_missing');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - rejects non-UUID idempotency_key', async () => {
    await ensureWorkspaceUserKeyBinding(OWNER, OWNER, OWNER_WS_KEY);
    const path = '/api/v4/records/checkout-doc-bad-idempotency/checkout/acquire';
    const payload = {
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
      record_family_hash: 'coworker:document',
      lease_seconds: 900,
      idempotency_key: 'not-a-uuid',
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerWsKeySecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('idempotency_key must be a UUID');
    expect(body.code).toBe('checkout_conflict');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - non-owner with write access can acquire checkout', async () => {
    const recordId = 'checkout-doc-member-writer';
    await createWritableCheckoutRecord(recordId, MEMBER);
    const memberCheckout = await acquireCheckout(recordId, 'coworker:document', MEMBER);
    expect(memberCheckout.res.status).toBe(200);
    const body = await memberCheckout.res.json();
    expect(body.checkout.checked_out_by_user_npub).toBe(MEMBER);
    expect(body.checkout.checked_out_by_workspace_user_key_npub).toBe(MEMBER_WS_KEY);
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - non-owner without write access is rejected by edit policy', async () => {
    const recordId = 'checkout-doc-member-read-only';
    await createOwnerOnlyWritableCheckoutRecord(recordId);
    await ensureWorkspaceReadableGroup(OWNER, MEMBER);
    const memberCheckout = await acquireCheckout(recordId, 'coworker:document', MEMBER);
    expect(memberCheckout.res.status).toBe(403);
    const body = await memberCheckout.res.json();
    expect(body.code).toBe('edit_policy_forbidden');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - unauthorized actor without workspace access is rejected', async () => {
    await ensureWorkspaceUserKeyBinding(OUTSIDER, OWNER, OUTSIDER_WS_KEY);
    const path = '/api/v4/records/checkout-doc-unauthorized/checkout/acquire';
    const payload = {
      workspace_service_npub: OWNER,
      user_npub: OUTSIDER,
      workspace_user_key_npub: OUTSIDER_WS_KEY,
      record_family_hash: 'coworker:document',
      lease_seconds: 900,
      idempotency_key: crypto.randomUUID(),
    };
    const res = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', outsiderWsKeySecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('record_pull_forbidden');
    expect(body.reason_code).toBe('group_membership_revoked');
  });

  test('POST /api/v4/records/:record_id/checkout/acquire - writable non-owner sees active checkout conflict', async () => {
    const recordId = 'checkout-doc-002';
    await createWritableCheckoutRecord(recordId, MEMBER);
    const ownerCheckout = await acquireCheckout(recordId, 'coworker:document', OWNER);
    expect(ownerCheckout.res.status).toBe(200);

    const memberPath = `/api/v4/records/${recordId}/checkout/acquire`;
    await ensureWorkspaceUserKeyBinding(MEMBER, OWNER, MEMBER_WS_KEY);
    const memberPayload = {
      workspace_service_npub: OWNER,
      user_npub: MEMBER,
      workspace_user_key_npub: MEMBER_WS_KEY,
      record_family_hash: 'coworker:document',
      lease_seconds: 900,
      idempotency_key: crypto.randomUUID(),
    };
    const memberRes = await app.request(memberPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(memberPath, 'POST', memberWsKeySecret, memberPayload),
      },
      body: JSON.stringify(memberPayload),
    });
    expect(memberRes.status).toBe(409);
    const memberBody = await memberRes.json();
    expect(memberBody.code).toBe('record_checked_out');
  });

  test('POST /api/v4/records/:record_id/checkout/release - owner succeeds and non-owner fails', async () => {
    const recordId = 'checkout-doc-003';
    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    expect(acquired.res.status).toBe(200);
    const acquiredBody = await acquired.res.json();

    const releasePath = `/api/v4/records/${recordId}/checkout/release`;
    const releasePayload = {
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
      record_family_hash: 'coworker:document',
      checkout_id: acquiredBody.checkout.checkout_id,
    };
    const releaseRes = await app.request(releasePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(releasePath, 'POST', ownerWsKeySecret, releasePayload),
      },
      body: JSON.stringify(releasePayload),
    });
    expect(releaseRes.status).toBe(200);
    const releaseBody = await releaseRes.json();
    expect(releaseBody.checkout.state).toBe('checked_in');

    const outsiderCheckout = await acquireCheckout('checkout-doc-004', 'coworker:document', OWNER);
    const outsiderBody = await outsiderCheckout.res.json();
    const badReleasePayload = {
      workspace_service_npub: OWNER,
      user_npub: MEMBER,
      workspace_user_key_npub: MEMBER_WS_KEY,
      record_family_hash: 'coworker:document',
      checkout_id: outsiderBody.checkout.checkout_id,
    };
    await ensureWorkspaceUserKeyBinding(MEMBER, OWNER, MEMBER_WS_KEY);
    await ensureWorkspaceReadableGroup(OWNER, MEMBER);
    const badReleaseRes = await app.request('/api/v4/records/checkout-doc-004/checkout/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/checkout-doc-004/checkout/release', 'POST', memberWsKeySecret, badReleasePayload),
      },
      body: JSON.stringify(badReleasePayload),
    });
    expect(badReleaseRes.status).toBe(403);
    const badReleaseBody = await badReleaseRes.json();
    expect(badReleaseBody.code).toBe('checkout_not_owner');
  });

  test('POST /api/v4/records/:record_id/checkout/renew - extends the lease for the owner', async () => {
    const recordId = 'checkout-doc-005';
    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    const acquiredBody = await acquired.res.json();

    const renewPath = `/api/v4/records/${recordId}/checkout/renew`;
    const renewPayload = {
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
      record_family_hash: 'coworker:document',
      checkout_id: acquiredBody.checkout.checkout_id,
      lease_seconds: 1800,
    };
    const renewRes = await app.request(renewPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(renewPath, 'POST', ownerWsKeySecret, renewPayload),
      },
      body: JSON.stringify(renewPayload),
    });
    expect(renewRes.status).toBe(200);
    const renewBody = await renewRes.json();
    expect(new Date(renewBody.checkout.lease_expires_at).getTime()).toBeGreaterThan(
      new Date(acquiredBody.checkout.lease_expires_at).getTime(),
    );
  });

  test('POST /api/v4/records/sync - checkout_required create may omit checkout; update requires checkout and auto-releases', async () => {
    const recordId = 'checkout-sync-doc-001';
    const createWithoutCheckout = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'doc_without_checkout' },
        },
      ],
    };
    const createRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, createWithoutCheckout),
      },
      body: JSON.stringify(createWithoutCheckout),
    });
    expect(createRes.status).toBe(200);
    const createBody = await createRes.json();
    expect(createBody.created).toBe(1);
    expect(createBody.rejected).toHaveLength(0);

    const updateWithoutCheckout = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'doc_update_without_checkout' },
        },
      ],
    };
    const missingRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, updateWithoutCheckout),
      },
      body: JSON.stringify(updateWithoutCheckout),
    });
    expect(missingRes.status).toBe(200);
    const missingBody = await missingRes.json();
    expect(missingBody.synced).toBe(0);
    expect(missingBody.rejected[0].code).toBe('checkout_missing');

    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    const acquiredBody = await acquired.res.json();
    const withCheckout = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'doc_with_checkout' },
        },
      ],
    };
    const successRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, withCheckout),
      },
      body: JSON.stringify(withCheckout),
    });
    expect(successRes.status).toBe(200);
    const successBody = await successRes.json();
    expect(successBody.updated).toBe(1);
    expect(successBody.rejected).toHaveLength(0);

    const [checkoutRow] = await sql<{ state: string }[]>`
      SELECT state
      FROM v4_record_checkouts
      WHERE checkout_id = ${acquiredBody.checkout.checkout_id}
    `;
    expect(checkoutRow.state).toBe('checked_in');
  });

  test('POST /api/v4/records/sync - default checkout policy preserves Phase 1 family behavior', async () => {
    const directoryWithoutCheckout = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'checkout-policy-default-directory',
          owner_npub: OWNER,
          record_family_hash: 'coworker:directory',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'directory_without_checkout' },
        },
      ],
    };
    const directoryCreateRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, directoryWithoutCheckout),
      },
      body: JSON.stringify(directoryWithoutCheckout),
    });
    expect(directoryCreateRes.status).toBe(200);
    const directoryCreateBody = await directoryCreateRes.json();
    expect(directoryCreateBody.created).toBe(1);
    expect(directoryCreateBody.rejected).toHaveLength(0);

    const directoryUpdateWithoutCheckout = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'checkout-policy-default-directory',
          owner_npub: OWNER,
          record_family_hash: 'coworker:directory',
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'directory_update_without_checkout' },
        },
      ],
    };
    const directoryUpdateRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, directoryUpdateWithoutCheckout),
      },
      body: JSON.stringify(directoryUpdateWithoutCheckout),
    });
    expect(directoryUpdateRes.status).toBe(200);
    const directoryUpdateBody = await directoryUpdateRes.json();
    expect(directoryUpdateBody.synced).toBe(0);
    expect(directoryUpdateBody.rejected[0].code).toBe('checkout_missing');

    const optimisticFamilies = ['task', 'chat', 'chat_message', 'channel', 'comment', 'reaction'];
    const optimisticPayload = {
      owner_npub: OWNER,
      records: optimisticFamilies.map((suffix) => ({
        record_id: `checkout-policy-default-${suffix}`,
        owner_npub: OWNER,
        record_family_hash: `coworker:${suffix}`,
        version: 1,
        previous_version: 0,
        signature_npub: OWNER,
        owner_payload: { ciphertext: `${suffix}_without_checkout` },
      })),
    };
    const optimisticRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, optimisticPayload),
      },
      body: JSON.stringify(optimisticPayload),
    });
    expect(optimisticRes.status).toBe(200);
    const optimisticBody = await optimisticRes.json();
    expect(optimisticBody.synced).toBe(optimisticFamilies.length);
    expect(optimisticBody.created).toBe(optimisticFamilies.length);
    expect(optimisticBody.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - policy opt-in can require checkout for a non-default family', async () => {
    const recordId = 'checkout-policy-task-opt-in';
    const recordFamilyHash = 'coworker:task_policy_opt_in';
    setRecordCheckoutPolicyOverridesForTests({
      recordFamilyHashes: {
        [recordFamilyHash]: 'checkout_required',
      },
    });

    const createWithoutCheckout = {
      owner_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          record_family_hash: recordFamilyHash,
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'task_without_checkout' },
        },
      ],
    };
    const createRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, createWithoutCheckout),
      },
      body: JSON.stringify(createWithoutCheckout),
    });
    expect(createRes.status).toBe(200);
    const createBody = await createRes.json();
    expect(createBody.created).toBe(1);
    expect(createBody.rejected).toHaveLength(0);

    const updateWithoutCheckout = {
      owner_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          record_family_hash: recordFamilyHash,
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'task_update_without_checkout' },
        },
      ],
    };
    const missingRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, updateWithoutCheckout),
      },
      body: JSON.stringify(updateWithoutCheckout),
    });
    expect(missingRes.status).toBe(200);
    const missingBody = await missingRes.json();
    expect(missingBody.synced).toBe(0);
    expect(missingBody.rejected[0].code).toBe('checkout_missing');

    const acquired = await acquireCheckout(recordId, recordFamilyHash, OWNER);
    expect(acquired.res.status).toBe(200);
    const acquiredBody = await acquired.res.json();

    const withCheckout = {
      owner_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          record_family_hash: recordFamilyHash,
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'task_with_checkout' },
        },
      ],
    };
    const successRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, withCheckout),
      },
      body: JSON.stringify(withCheckout),
    });
    expect(successRes.status).toBe(200);
    const successBody = await successRes.json();
    expect(successBody.updated).toBe(1);
    expect(successBody.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - owner user via delegated workspace user key can write checkout_required record', async () => {
    const recordId = 'checkout-policy-owner-delegated-key';
    await ensureWorkspaceUserKeyBinding(OWNER, OWNER, OWNER_WS_KEY);
    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    expect(acquired.res.status).toBe(200);
    const acquiredBody = await acquired.res.json();

    const payload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          workspace_user_key_npub: OWNER_WS_KEY,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER_WS_KEY,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'owner_delegated_key_doc' },
        },
      ],
    };
    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerWsKeySecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - non-owner with writable group can update checkout_required record', async () => {
    const recordId = 'checkout-policy-member-writer';
    const writeGroup = await createWritableCheckoutRecord(recordId, MEMBER);
    const acquired = await acquireCheckout(recordId, 'coworker:document', MEMBER);
    expect(acquired.res.status).toBe(200);
    const acquiredBody = await acquired.res.json();

    const payload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: MEMBER,
      workspace_user_key_npub: MEMBER_WS_KEY,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          workspace_user_key_npub: MEMBER_WS_KEY,
          record_family_hash: 'coworker:document',
          version: 2,
          previous_version: 1,
          signature_npub: MEMBER_WS_KEY,
          write_group_id: writeGroup.groupId,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'member_writer_doc_v2' },
          group_payloads: [
            {
              group_id: writeGroup.groupId,
              group_npub: writeGroup.groupNpub,
              ciphertext: 'member_writer_group_v2',
              write: true,
            },
          ],
        },
      ],
    };
    const proofPayload = { ...payload };
    const bodyWithTokens = {
      ...payload,
      group_write_tokens: {
        [writeGroup.groupId]: authHeader('/api/v4/records/sync', 'POST', checkoutWriteGroupSecret, proofPayload),
      },
    };
    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberWsKeySecret, bodyWithTokens),
      },
      body: JSON.stringify(bodyWithTokens),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.updated).toBe(1);
    expect(body.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - force_write repairs missing prior-version group write access', async () => {
    const recordId = 'force-write-prior-acl-repair';
    await ensureWorkspaceUserKeyBinding(MEMBER, OWNER, MEMBER_WS_KEY);
    await createOwnerOnlyWritableCheckoutRecord(recordId, 'coworker:chat_message');
    const writeGroup = await createWritableCheckoutRecord(`${recordId}-writer-group`, MEMBER, 'coworker:chat_message');

    const baseRecord = {
      record_id: recordId,
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      workspace_user_key_npub: MEMBER_WS_KEY,
      record_family_hash: 'coworker:chat_message',
      version: 2,
      previous_version: 1,
      signature_npub: MEMBER_WS_KEY,
      write_group_id: writeGroup.groupId,
      owner_payload: { ciphertext: 'force_write_owner_v2' },
      group_payloads: [
        {
          group_id: writeGroup.groupId,
          group_npub: writeGroup.groupNpub,
          ciphertext: 'force_write_group_v2',
          write: true,
        },
      ],
    };
    const rejectedProofPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: MEMBER,
      workspace_user_key_npub: MEMBER_WS_KEY,
      records: [baseRecord],
    };
    const rejectedPayload = {
      ...rejectedProofPayload,
      group_write_tokens: {
        [writeGroup.groupId]: authHeader('/api/v4/records/sync', 'POST', checkoutWriteGroupSecret, rejectedProofPayload),
      },
    };
    const rejectedRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberWsKeySecret, rejectedPayload),
      },
      body: JSON.stringify(rejectedPayload),
    });
    expect(rejectedRes.status).toBe(200);
    const rejectedBody = await rejectedRes.json();
    expect(rejectedBody.synced).toBe(0);
    expect(rejectedBody.rejected[0].reason).toContain('does not have write access on prior version');

    const forceRecord = { ...baseRecord, force_write: true };
    const forceProofPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: MEMBER,
      workspace_user_key_npub: MEMBER_WS_KEY,
      records: [forceRecord],
    };
    const forcePayload = {
      ...forceProofPayload,
      group_write_tokens: {
        [writeGroup.groupId]: authHeader('/api/v4/records/sync', 'POST', checkoutWriteGroupSecret, forceProofPayload),
      },
    };
    const forceRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberWsKeySecret, forcePayload),
      },
      body: JSON.stringify(forcePayload),
    });

    expect(forceRes.status).toBe(200);
    const forceBody = await forceRes.json();
    expect(forceBody.synced).toBe(1);
    expect(forceBody.updated).toBe(1);
    expect(forceBody.rejected).toHaveLength(0);
    expect(forceBody.warnings[0]).toMatchObject({
      code: 'force_write_prior_acl_repair',
      record_id: recordId,
      write_group_id: writeGroup.groupId,
    });
  });

  test('POST /api/v4/records/sync - force_write bypasses stale checkout validation for checkout_required records', async () => {
    const recordId = 'force-write-stale-checkout-repair';
    const createPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'force_checkout_v1' },
        },
      ],
    };
    const createRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, createPayload),
      },
      body: JSON.stringify(createPayload),
    });
    expect(createRes.status).toBe(200);
    expect((await createRes.json()).created).toBe(1);

    const forcePayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          force_write: true,
          checkout: {
            checkout_id: '00000000-0000-4000-8000-000000000000',
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'force_checkout_v2' },
        },
      ],
    };
    const forceRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, forcePayload),
      },
      body: JSON.stringify(forcePayload),
    });

    expect(forceRes.status).toBe(200);
    const forceBody = await forceRes.json();
    expect(forceBody.synced).toBe(1);
    expect(forceBody.updated).toBe(1);
    expect(forceBody.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - wrong checkout holder fails and failed write keeps checkout', async () => {
    const recordId = 'checkout-sync-doc-002';
    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    const acquiredBody = await acquired.res.json();

    const wrongHolderPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: MEMBER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: MEMBER,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'wrong_holder' },
        },
      ],
    };
    const wrongHolderRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberSecret, wrongHolderPayload),
      },
      body: JSON.stringify(wrongHolderPayload),
    });
    expect(wrongHolderRes.status).toBe(200);
    const wrongHolderBody = await wrongHolderRes.json();
    expect(wrongHolderBody.rejected[0].code).toBe('checkout_not_owner');

    const staleRecordId = 'checkout-sync-doc-003';
    const createCheckout = await acquireCheckout(staleRecordId, 'coworker:document', OWNER);
    const createCheckoutBody = await createCheckout.res.json();
    const createPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: staleRecordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: createCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'stale_base_v1' },
        },
      ],
    };
    const createRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, createPayload),
      },
      body: JSON.stringify(createPayload),
    });
    expect(createRes.status).toBe(200);

    const updateCheckout = await acquireCheckout(staleRecordId, 'coworker:document', OWNER);
    const updateCheckoutBody = await updateCheckout.res.json();
    const badUpdatePayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: staleRecordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 2,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: updateCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'stale_base_v2' },
        },
      ],
    };
    const badUpdateRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, badUpdatePayload),
      },
      body: JSON.stringify(badUpdatePayload),
    });
    expect(badUpdateRes.status).toBe(200);
    const badUpdateBody = await badUpdateRes.json();
    expect(badUpdateBody.rejected[0].code).toBe('prior_version_mismatch');

    const [activeCheckout] = await sql<{ state: string }[]>`
      SELECT state
      FROM v4_record_checkouts
      WHERE checkout_id = ${updateCheckoutBody.checkout.checkout_id}
    `;
    expect(activeCheckout.state).toBe('checked_out');
  });

  test('POST /api/v4/records/sync - existing record family is immutable on update', async () => {
    const recordId = 'checkout-sync-doc-family-mismatch';
    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    const acquiredBody = await acquired.res.json();
    const createPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'family_mismatch_v1' },
        },
      ],
    };
    const createRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, createPayload),
      },
      body: JSON.stringify(createPayload),
    });
    expect(createRes.status).toBe(200);

    const mismatchPayload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'family_mismatch_v2' },
        },
      ],
    };
    const mismatchRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, mismatchPayload),
      },
      body: JSON.stringify(mismatchPayload),
    });
    expect(mismatchRes.status).toBe(200);
    const mismatchBody = await mismatchRes.json();
    expect(mismatchBody.synced).toBe(0);
    expect(mismatchBody.rejected[0].code).toBe('checkout_conflict');
    expect(mismatchBody.rejected[0].reason).toContain('record_family_hash mismatch');
  });

  test('POST /api/v4/records/sync - duplicate checkout_required write request returns success-equivalent result', async () => {
    const recordId = 'checkout-sync-doc-004';
    const acquired = await acquireCheckout(recordId, 'coworker:document', OWNER);
    const acquiredBody = await acquired.res.json();
    const payload = {
      owner_npub: OWNER,
      workspace_service_npub: OWNER,
      user_npub: OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: OWNER,
          workspace_service_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: acquiredBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'duplicate_v1' },
        },
      ],
    };

    const firstRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.created).toBe(1);

    const secondRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.created).toBe(1);
    expect(secondBody.rejected).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - validates input', async () => {
    const payload = { owner_npub: OWNER };
    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/v4/records - fetch latest by record_family_hash', async () => {
    const path = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=${FAMILY_HASH}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toHaveLength(1);

    const rec = body.records[0];
    expect(rec.record_id).toBe(RECORD_ID);
    expect(rec.version).toBe(2);
    expect(rec.owner_payload.ciphertext).toBe('encrypted_hello_v2');
    expect(rec.group_payloads).toHaveLength(1);
    expect(rec.group_payloads[0].group_npub).toBe(GROUP_NPUB);
  });

  test('GET /api/v4/records - since filter', async () => {
    // Use a far-future date to get no results
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const path = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=${FAMILY_HASH}&since=${futureDate}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records).toHaveLength(0);
  });

  test('GET /api/v4/records - pagination supports recent bootstrap and older history pull', async () => {
    const runtimeFamily = 'wingman-fd:chat_message_runtime_history';
    const runtimeRecords = ['runtime-msg-1', 'runtime-msg-2', 'runtime-msg-3'];

    for (const [index, recordId] of runtimeRecords.entries()) {
      const payload = {
        owner_npub: OWNER,
        records: [
          {
            record_id: recordId,
            owner_npub: OWNER,
            record_family_hash: runtimeFamily,
            version: 1,
            previous_version: 0,
            signature_npub: OWNER,
            owner_payload: { ciphertext: `runtime_ciphertext_${index + 1}` },
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
    }

    await sql`
      UPDATE v4_records
      SET updated_at = CASE record_id
        WHEN 'runtime-msg-1' THEN TIMESTAMPTZ '2026-04-08T09:00:00Z'
        WHEN 'runtime-msg-2' THEN TIMESTAMPTZ '2026-04-08T09:01:00Z'
        WHEN 'runtime-msg-3' THEN TIMESTAMPTZ '2026-04-08T09:02:00Z'
        ELSE updated_at
      END
      WHERE owner_npub = ${OWNER}
        AND record_family_hash = ${runtimeFamily}
        AND record_id IN ('runtime-msg-1', 'runtime-msg-2', 'runtime-msg-3')
    `;

    const firstPagePath = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=${encodeURIComponent(runtimeFamily)}&limit=1&offset=0`;
    const firstPageRes = await app.request(firstPagePath, {
      headers: {
        Authorization: authHeader(firstPagePath, 'GET', ownerSecret),
      },
    });
    expect(firstPageRes.status).toBe(200);

    const firstPageBody = await firstPageRes.json();
    expect(firstPageBody.total).toBe(3);
    expect(firstPageBody.limit).toBe(1);
    expect(firstPageBody.offset).toBe(0);
    expect(firstPageBody.has_more).toBe(true);
    expect(firstPageBody.records.map((record: any) => record.record_id)).toEqual(['runtime-msg-1']);

    const recentPagePath = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=${encodeURIComponent(runtimeFamily)}&limit=2&offset=1`;
    const recentPageRes = await app.request(recentPagePath, {
      headers: {
        Authorization: authHeader(recentPagePath, 'GET', ownerSecret),
      },
    });
    expect(recentPageRes.status).toBe(200);

    const recentPageBody = await recentPageRes.json();
    expect(recentPageBody.total).toBe(3);
    expect(recentPageBody.limit).toBe(2);
    expect(recentPageBody.offset).toBe(1);
    expect(recentPageBody.has_more).toBe(false);
    expect(recentPageBody.records.map((record: any) => record.record_id)).toEqual([
      'runtime-msg-2',
      'runtime-msg-3',
    ]);
  });

  test('GET /api/v4/records - member viewer only sees records shared to their groups', async () => {
    const createGroupPayload = {
      owner_npub: OWNER,
      name: 'Shared docs',
      group_npub: 'npub1shared_docs_group_test',
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'wrapped_key_owner_shared',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: MEMBER,
          wrapped_group_nsec: 'wrapped_key_member_shared',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createGroupPayload),
      },
      body: JSON.stringify(createGroupPayload),
    });

    expect(groupRes.status).toBe(201);
    const groupBody = await groupRes.json();
    const sharedGroupNpub = groupBody.group_npub;
    const privateCheckout = await acquireCheckout('member-private-doc', 'coworker:document', OWNER);
    const sharedCheckout = await acquireCheckout('member-shared-doc', 'coworker:document', OWNER);
    const privateCheckoutBody = await privateCheckout.res.json();
    const sharedCheckoutBody = await sharedCheckout.res.json();

    const syncPayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'member-private-doc',
          owner_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: privateCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'private_doc' },
        },
        {
          record_id: 'member-shared-doc',
          owner_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: sharedCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'shared_doc' },
          group_payloads: [
            {
              group_npub: sharedGroupNpub,
              ciphertext: 'shared_doc_for_member',
              write: false,
            },
          ],
        },
      ],
    };
    const syncRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, syncPayload),
      },
      body: JSON.stringify(syncPayload),
    });

    expect(syncRes.status).toBe(200);

    const ownerFetchPath = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${OWNER}&record_family_hash=coworker:document`;
    const ownerFetchRes = await app.request(ownerFetchPath, {
      headers: {
        Authorization: authHeader(ownerFetchPath, 'GET', ownerSecret),
      },
    });
    expect(ownerFetchRes.status).toBe(200);
    const ownerFetchBody = await ownerFetchRes.json();
    expect(ownerFetchBody.records.map((record) => record.record_id)).toEqual(
      expect.arrayContaining(['member-private-doc', 'member-shared-doc'])
    );

    const memberFetchPath = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${MEMBER}&record_family_hash=coworker:document`;
    const memberFetchRes = await app.request(memberFetchPath, {
      headers: {
        Authorization: authHeader(memberFetchPath, 'GET', memberSecret),
      },
    });
    expect(memberFetchRes.status).toBe(200);
    const memberFetchBody = await memberFetchRes.json();
    expect(memberFetchBody.records).toHaveLength(1);
    expect(memberFetchBody.records[0].record_id).toBe('member-shared-doc');

    const outsiderFetchPath = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${OUTSIDER}&record_family_hash=coworker:document`;
    const outsiderFetchRes = await app.request(outsiderFetchPath, {
      headers: {
        Authorization: authHeader(outsiderFetchPath, 'GET', outsiderSecret),
      },
    });
    expect(outsiderFetchRes.status).toBe(200);
    const outsiderFetchBody = await outsiderFetchRes.json();
    expect(outsiderFetchBody.records).toHaveLength(0);
  });

  test('GET /api/v4/records - removed members keep access to old epoch records but not new epoch records', async () => {
    const createGroupPayload = {
      owner_npub: OWNER,
      name: 'Epoch test',
      group_npub: 'npub1epoch_test_group_v1',
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'epoch1_owner_key',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: MEMBER,
          wrapped_group_nsec: 'epoch1_member_key',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createGroupPayload),
      },
      body: JSON.stringify(createGroupPayload),
    });
    expect(groupRes.status).toBe(201);
    const groupBody = await groupRes.json();
    const beforeRotateCheckout = await acquireCheckout('epoch-shared-v1', 'coworker:document', OWNER);
    const beforeRotateCheckoutBody = await beforeRotateCheckout.res.json();

    const beforeRotatePayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'epoch-shared-v1',
          owner_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: beforeRotateCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'epoch_1_owner_payload' },
          group_payloads: [
            {
              group_id: groupBody.group_id,
              group_epoch: 1,
              group_npub: groupBody.group_npub,
              ciphertext: 'epoch_1_group_payload',
              write: true,
            },
          ],
        },
      ],
    };
    const beforeRotateRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, beforeRotatePayload),
      },
      body: JSON.stringify(beforeRotatePayload),
    });
    expect(beforeRotateRes.status).toBe(200);

    const rotatePath = `/api/v4/groups/${groupBody.group_id}/rotate`;
    const rotatePayload = {
      group_npub: 'npub1epoch_test_group_v2',
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'epoch2_owner_key',
          wrapped_by_npub: OWNER,
        },
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
    expect(rotateRes.status).toBe(200);
    const rotateBody = await rotateRes.json();
    expect(rotateBody.current_epoch).toBe(2);
    const afterRotateCheckout = await acquireCheckout('epoch-shared-v2', 'coworker:document', OWNER);
    const afterRotateCheckoutBody = await afterRotateCheckout.res.json();

    const afterRotatePayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'epoch-shared-v2',
          owner_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: afterRotateCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'epoch_2_owner_payload' },
          group_payloads: [
            {
              group_id: groupBody.group_id,
              group_epoch: rotateBody.current_epoch,
              group_npub: rotateBody.group_npub,
              ciphertext: 'epoch_2_group_payload',
              write: true,
            },
          ],
        },
      ],
    };
    const afterRotateRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, afterRotatePayload),
      },
      body: JSON.stringify(afterRotatePayload),
    });
    expect(afterRotateRes.status).toBe(200);

    const memberFetchPath = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${MEMBER}&record_family_hash=coworker:document`;
    const memberFetchRes = await app.request(memberFetchPath, {
      headers: {
        Authorization: authHeader(memberFetchPath, 'GET', memberSecret),
      },
    });
    expect(memberFetchRes.status).toBe(200);
    const memberFetchBody = await memberFetchRes.json();
    expect(memberFetchBody.records.map((record: any) => record.record_id)).toContain('epoch-shared-v1');
    expect(memberFetchBody.records.map((record: any) => record.record_id)).not.toContain('epoch-shared-v2');
  });

  test('GET /api/v4/records - records with unresolved group_id are not visible to members via fallback path', async () => {
    // Directly insert a record with group_id=NULL but group_npub matching a group
    // to simulate the fallback visibility path (Path 2) that was removed.
    // This record should NOT be visible to non-owner members.
    const UNRESOLVED_FAMILY = 'unresolved_group_family';

    // Create a group with MEMBER
    const createGroupPayload = {
      owner_npub: OWNER,
      name: 'Unresolved test group',
      group_npub: 'npub1unresolved_test_group',
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'unresolved_owner_key',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: MEMBER,
          wrapped_group_nsec: 'unresolved_member_key',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createGroupPayload),
      },
      body: JSON.stringify(createGroupPayload),
    });
    expect(groupRes.status).toBe(201);
    const groupBody = await groupRes.json();

    // Sync a record with only group_npub (no group_id) using a DIFFERENT npub
    // that happens to match no epoch, forcing group_id to stay NULL in the stored payload.
    // We do this by directly inserting into the DB to simulate the edge case.
    const recordId = 'unresolved-group-record';
    await sql`
      INSERT INTO v4_records (record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext)
      VALUES (${recordId}, ${OWNER}, ${UNRESOLVED_FAMILY}, 1, 0, ${OWNER}, 'unresolved_payload')
    `;
    const [insertedRecord] = await sql<{ id: string }[]>`
      SELECT id FROM v4_records WHERE record_id = ${recordId}
    `;
    // Insert a group payload with group_id=NULL but matching group_npub
    await sql`
      INSERT INTO v4_record_group_payloads (record_row_id, group_id, group_epoch, group_npub, ciphertext, can_write)
      VALUES (${insertedRecord.id}, NULL, NULL, ${'npub1unresolved_test_group'}, 'unresolved_group_ciphertext', TRUE)
    `;

    // Member should NOT see this record (the old Path 2 fallback would have let them)
    const memberFetchPath = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${MEMBER}&record_family_hash=${UNRESOLVED_FAMILY}`;
    const memberFetchRes = await app.request(memberFetchPath, {
      headers: {
        Authorization: authHeader(memberFetchPath, 'GET', memberSecret),
      },
    });
    expect(memberFetchRes.status).toBe(200);
    const memberFetchBody = await memberFetchRes.json();
    expect(memberFetchBody.records).toHaveLength(0);

    // Owner should still see it
    const ownerFetchPath = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=${UNRESOLVED_FAMILY}`;
    const ownerFetchRes = await app.request(ownerFetchPath, {
      headers: {
        Authorization: authHeader(ownerFetchPath, 'GET', ownerSecret),
      },
    });
    expect(ownerFetchRes.status).toBe(200);
    const ownerFetchBody = await ownerFetchRes.json();
    expect(ownerFetchBody.records).toHaveLength(1);
    expect(ownerFetchBody.records[0].record_id).toBe(recordId);
  });

  test('GET /api/v4/records - requires owner_npub and record_family_hash', async () => {
    const res1 = await app.request('/api/v4/records', {
      headers: {
        Authorization: authHeader('/api/v4/records', 'GET', ownerSecret),
      },
    });
    expect(res1.status).toBe(400);

    const path = `/api/v4/records?owner_npub=${OWNER}`;
    const res2 = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(res2.status).toBe(400);
  });

  test('POST /api/v4/records/sync - multiple records in one batch', async () => {
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'rec-batch-1',
          owner_npub: OWNER,
          record_family_hash: 'chat_msg_hash',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'msg1' },
        },
        {
          record_id: 'rec-batch-2',
          owner_npub: OWNER,
          record_family_hash: 'chat_msg_hash',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: 'msg2' },
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
    const body = await res.json();
    expect(body.synced).toBe(2);
    expect(body.created).toBe(2);
  });

  test('POST /api/v4/records/sync - member can create shared record with canonical write_group_id in strict mode', async () => {
    const createGroupPayload = {
      owner_npub: OWNER,
      name: 'Canonical Writers',
      group_npub: GROUP_ID_WRITE_NPUB,
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'wrapped_owner_canonical_writer_key',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: MEMBER,
          wrapped_group_nsec: 'wrapped_member_canonical_writer_key',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createGroupPayload),
      },
      body: JSON.stringify(createGroupPayload),
    });
    expect(groupRes.status).toBe(201);
    const groupBody = await groupRes.json();

    const proofPayload = {
      owner_npub: OWNER,
      strict_group_id_writes: true,
      records: [
        {
          record_id: 'member-shared-write-group-id',
          owner_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: MEMBER,
          write_group_id: groupBody.group_id,
          owner_payload: { ciphertext: 'member_owner_payload_group_id' },
          group_payloads: [
            {
              group_id: groupBody.group_id,
              group_npub: GROUP_ID_WRITE_NPUB,
              ciphertext: 'member_group_payload_group_id',
              write: true,
            },
          ],
        },
      ],
    };
    const payload = {
      ...proofPayload,
      group_write_tokens: {
        [groupBody.group_id]: authHeader('/api/v4/records/sync', 'POST', groupIdSecret, proofPayload),
      },
    };

    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.rejected).toHaveLength(0);
    expect(body.warnings).toHaveLength(0);
  });

  test('POST /api/v4/records/sync - member can create shared record with legacy write_group_npub compatibility warning', async () => {
    const createGroupPayload = {
      owner_npub: OWNER,
      name: 'Writers',
      group_npub: GROUP_WRITE_NPUB,
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'wrapped_owner_writer_key',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: MEMBER,
          wrapped_group_nsec: 'wrapped_member_writer_key',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createGroupPayload),
      },
      body: JSON.stringify(createGroupPayload),
    });
    expect(groupRes.status).toBe(201);

    const proofPayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'member-shared-write',
          owner_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: MEMBER,
          write_group_npub: GROUP_WRITE_NPUB,
          owner_payload: { ciphertext: 'member_owner_payload' },
          group_payloads: [
            {
              group_npub: GROUP_WRITE_NPUB,
              ciphertext: 'member_group_payload',
              write: true,
            },
          ],
        },
      ],
    };
    const payload = {
      ...proofPayload,
      group_write_tokens: {
        [GROUP_WRITE_NPUB]: authHeader('/api/v4/records/sync', 'POST', groupSecret, proofPayload),
      },
    };

    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBe(1);
    expect(body.rejected).toHaveLength(0);
    expect(body.warnings).toEqual([
      expect.objectContaining({
        code: 'legacy_write_group_npub',
        record_id: 'member-shared-write',
        field: 'write_group_npub',
        write_group_id: null,
        write_group_npub: GROUP_WRITE_NPUB,
      }),
    ]);
  });

  test('POST /api/v4/records/sync - strict mode rejects write_group_npub as write reference', async () => {
    const createGroupPayload = {
      owner_npub: OWNER,
      name: 'Strict Legacy Writers',
      group_npub: STRICT_LEGACY_GROUP_NPUB,
      member_keys: [
        {
          member_npub: OWNER,
          wrapped_group_nsec: 'wrapped_owner_strict_legacy_writer_key',
          wrapped_by_npub: OWNER,
        },
        {
          member_npub: MEMBER,
          wrapped_group_nsec: 'wrapped_member_strict_legacy_writer_key',
          wrapped_by_npub: OWNER,
        },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, createGroupPayload),
      },
      body: JSON.stringify(createGroupPayload),
    });
    expect(groupRes.status).toBe(201);

    const payload = {
      owner_npub: OWNER,
      strict_group_id_writes: true,
      records: [
        {
          record_id: 'member-shared-write-strict-legacy',
          owner_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: MEMBER,
          write_group_npub: STRICT_LEGACY_GROUP_NPUB,
          owner_payload: { ciphertext: 'member_owner_payload_strict_legacy' },
          group_payloads: [
            {
              group_npub: STRICT_LEGACY_GROUP_NPUB,
              ciphertext: 'member_group_payload_strict_legacy',
              write: true,
            },
          ],
        },
      ],
    };

    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('legacy_write_group_npub_forbidden');
    expect(body.error).toContain('write_group_id');
    expect(body.error).toContain('group_payloads[].group_npub');
    expect(body.details.records[0]).toEqual(expect.objectContaining({
      record_id: 'member-shared-write-strict-legacy',
      write_group_npub: STRICT_LEGACY_GROUP_NPUB,
    }));
  });

  test('POST /api/v4/records/sync - strict group-id header rejects write_group_npub', async () => {
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'owner-write-strict-header-legacy',
          owner_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          write_group_npub: 'npub1strict_header_legacy',
          owner_payload: { ciphertext: 'owner_payload_strict_header' },
          group_payloads: [
            {
              group_npub: 'npub1strict_header_legacy',
              ciphertext: 'group_payload_strict_header',
              write: true,
            },
          ],
        },
      ],
    };

    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-superbased-strict-group-id-writes': 'true',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('legacy_write_group_npub_forbidden');
    expect(body.details.strict_group_id_writes).toBe(true);
    expect(body.details.records[0].record_id).toBe('owner-write-strict-header-legacy');
  });

  test('POST /api/v4/records/sync - identity strict header rejects write_group_npub', async () => {
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'owner-write-identity-strict-legacy',
          owner_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          write_group_npub: 'npub1identity_strict_legacy',
          owner_payload: { ciphertext: 'owner_payload_identity_strict' },
          group_payloads: [
            {
              group_npub: 'npub1identity_strict_legacy',
              ciphertext: 'group_payload_identity_strict',
              write: true,
            },
          ],
        },
      ],
    };

    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-superbased-identity-strict': 'workspace_user_key, group_id',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('legacy_write_group_npub_forbidden');
    expect(body.details.strict_group_id_writes).toBe(true);
    expect(body.details.records[0].record_id).toBe('owner-write-identity-strict-legacy');
  });

  test('POST /api/v4/records/sync - member shared write without group proof is rejected', async () => {
    const proofPayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'member-shared-write-no-proof',
          owner_npub: OWNER,
          record_family_hash: 'coworker:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: MEMBER,
          write_group_npub: GROUP_WRITE_NPUB,
          owner_payload: { ciphertext: 'member_owner_payload' },
          group_payloads: [
            {
              group_npub: GROUP_WRITE_NPUB,
              ciphertext: 'member_group_payload',
              write: true,
            },
          ],
        },
      ],
    };

    const res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', memberSecret, proofPayload),
      },
      body: JSON.stringify(proofPayload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toBe(0);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].reason).toContain('missing valid group write proof');
  });

  test('POST /api/v4/records/sync - document family preserves mixed read/write payloads', async () => {
    const checkout = await acquireCheckout('doc-001', 'coworker:document', OWNER);
    const checkoutBody = await checkout.res.json();
    const payload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'doc-001',
          owner_npub: OWNER,
          record_family_hash: 'coworker:document',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: checkoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'encrypted_doc_payload' },
          group_payloads: [
            {
              group_npub: 'group-readers',
              ciphertext: 'doc_for_readers',
              write: false,
            },
            {
              group_npub: 'group-editors',
              ciphertext: 'doc_for_editors',
              write: true,
            },
          ],
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
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.rejected).toHaveLength(0);

    const path = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=coworker:document`;
    const fetchRes = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(fetchRes.status).toBe(200);
    const fetchBody = await fetchRes.json();
    const documentRecord = fetchBody.records.find((record) => record.record_id === 'doc-001');
    expect(documentRecord).toBeDefined();
    expect(documentRecord.group_payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_npub: 'group-readers', write: false }),
        expect.objectContaining({ group_npub: 'group-editors', write: true }),
      ])
    );
  });

  test('POST /api/v4/records/sync - directory family supports normal version updates', async () => {
    const createCheckout = await acquireCheckout('dir-001', 'coworker:directory', OWNER);
    const createCheckoutBody = await createCheckout.res.json();
    const createPayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'dir-001',
          owner_npub: OWNER,
          record_family_hash: 'coworker:directory',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          checkout: {
            checkout_id: createCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'directory_v1' },
        },
      ],
    };
    const createRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, createPayload),
      },
      body: JSON.stringify(createPayload),
    });

    expect(createRes.status).toBe(200);
    const updateCheckout = await acquireCheckout('dir-001', 'coworker:directory', OWNER);
    const updateCheckoutBody = await updateCheckout.res.json();

    const updatePayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'dir-001',
          owner_npub: OWNER,
          record_family_hash: 'coworker:directory',
          version: 2,
          previous_version: 1,
          signature_npub: OWNER,
          checkout: {
            checkout_id: updateCheckoutBody.checkout.checkout_id,
            consume_on_success: true,
          },
          owner_payload: { ciphertext: 'directory_v2' },
        },
      ],
    };
    const updateRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, updatePayload),
      },
      body: JSON.stringify(updatePayload),
    });

    expect(updateRes.status).toBe(200);
    const body = await updateRes.json();
    expect(body.updated).toBe(1);
    expect(body.rejected).toHaveLength(0);
  });

  test('GET /api/v4/records - rejects spoofed viewer_npub', async () => {
    const path = `/api/v4/records?owner_npub=${OWNER}&viewer_npub=${MEMBER}&record_family_hash=${FAMILY_HASH}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(res.status).toBe(403);
  });

  // ---- Records Summary tests ----

  test('GET /api/v4/records/summary - owner can fetch summary for all visible families', async () => {
    const path = `/api/v4/records/summary?owner_npub=${OWNER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.families).toBeInstanceOf(Array);
    expect(body.families.length).toBeGreaterThan(0);

    // Each family should have the expected shape
    for (const fam of body.families) {
      expect(typeof fam.record_family_hash).toBe('string');
      expect(typeof fam.latest_updated_at).toBe('string');
      expect(typeof fam.latest_record_count).toBe('number');
      expect(fam.latest_record_count).toBeGreaterThan(0);
      // count_since should be null when since is not provided
      expect(fam.count_since).toBeNull();
    }

    // Should include families we created earlier
    const familyHashes = body.families.map((f: any) => f.record_family_hash);
    expect(familyHashes).toContain(FAMILY_HASH);
    expect(familyHashes).toContain('coworker:document');
  });

  test('GET /api/v4/records/summary - record_family_hash filter works', async () => {
    const path = `/api/v4/records/summary?owner_npub=${OWNER}&record_family_hash=${FAMILY_HASH}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.families).toHaveLength(1);
    expect(body.families[0].record_family_hash).toBe(FAMILY_HASH);
    expect(body.families[0].latest_record_count).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/v4/records/summary - since returns expected count_since', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const path = `/api/v4/records/summary?owner_npub=${OWNER}&record_family_hash=${FAMILY_HASH}&since=${pastDate}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.families).toHaveLength(1);
    expect(typeof body.families[0].count_since).toBe('number');
    expect(body.families[0].count_since).toBeGreaterThanOrEqual(1);

    // Far future should give count_since = 0
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const path2 = `/api/v4/records/summary?owner_npub=${OWNER}&record_family_hash=${FAMILY_HASH}&since=${futureDate}`;
    const res2 = await app.request(path2, {
      headers: {
        Authorization: authHeader(path2, 'GET', ownerSecret),
      },
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.families).toHaveLength(1);
    expect(body2.families[0].count_since).toBe(0);
  });

  test('GET /api/v4/records/summary - member viewer only sees shared families', async () => {
    const path = `/api/v4/records/summary?owner_npub=${OWNER}&viewer_npub=${MEMBER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', memberSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Member should only see families with shared records
    const familyHashes = body.families.map((f: any) => f.record_family_hash);
    // Member has access to coworker:document (shared group) and coworker:chat_message
    // but NOT to families without shared records
    expect(familyHashes).toContain('coworker:document');

    // Outsider should see nothing
    const path2 = `/api/v4/records/summary?owner_npub=${OWNER}&viewer_npub=${OUTSIDER}`;
    const res2 = await app.request(path2, {
      headers: {
        Authorization: authHeader(path2, 'GET', outsiderSecret),
      },
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.families).toHaveLength(0);
  });

  test('GET /api/v4/records/summary - rejects spoofed viewer_npub', async () => {
    const path = `/api/v4/records/summary?owner_npub=${OWNER}&viewer_npub=${MEMBER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(res.status).toBe(403);
  });

  test('GET /api/v4/records/summary - requires owner_npub', async () => {
    const path = `/api/v4/records/summary`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', ownerSecret),
      },
    });
    expect(res.status).toBe(400);
  });

  test('records sync/fetch treats ciphertext as opaque strings', async () => {
    const opaqueOwnerCiphertext = 'not-json-just-opaque-bytes-abc123!@#$%';
    const opaqueGroupCiphertext = 'also-opaque-group-payload-xyz789';

    const syncPayload = {
      owner_npub: OWNER,
      records: [
        {
          record_id: 'opaque-test-001',
          owner_npub: OWNER,
          record_family_hash: 'opaque_test_family',
          version: 1,
          previous_version: 0,
          signature_npub: OWNER,
          owner_payload: { ciphertext: opaqueOwnerCiphertext },
          group_payloads: [
            {
              group_npub: GROUP_NPUB,
              ciphertext: opaqueGroupCiphertext,
              write: false,
            },
          ],
        },
      ],
    };
    const syncRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, syncPayload),
      },
      body: JSON.stringify(syncPayload),
    });
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.created).toBe(1);

    const fetchPath = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=opaque_test_family`;
    const fetchRes = await app.request(fetchPath, {
      headers: {
        Authorization: authHeader(fetchPath, 'GET', ownerSecret),
      },
    });
    expect(fetchRes.status).toBe(200);
    const fetchBody = await fetchRes.json();
    const rec = fetchBody.records.find((r: any) => r.record_id === 'opaque-test-001');
    expect(rec).toBeDefined();
    expect(rec.owner_payload.ciphertext).toBe(opaqueOwnerCiphertext);
    expect(rec.group_payloads[0].ciphertext).toBe(opaqueGroupCiphertext);
  });
});
