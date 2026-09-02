/**
 * Phase 1 bot workspace-key contract tests.
 *
 * Locks the following Tower behavior for bot actors:
 *   - a bot can register a workspace session key (ws_key_npub) for a
 *     workspace it has access to (signs the registration with its real npub)
 *   - a bot can fetch its wrapped group keys when signing with the registered
 *     ws_key_npub (auth resolves to the bot's real identity)
 *   - if the bot is a current member of a readable group but no wrapped key
 *     row covers that membership, GET /api/v4/groups/keys returns a
 *     diagnostic failure rather than a misleading empty success
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_bot_keys';

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
  // Flush the module-level ws_key resolution cache so that ws_key→user
  // mappings registered against this test database do not bleed into
  // sibling test files (which run concurrently against their own DBs but
  // share the same JS module instance).
  clearWsKeyCacheForTests();
  if (sql) await sql.end();
});

// Byte fills 61..65 chosen to avoid collision with any other test file's
// secrets — the module-level ws_key resolution cache is shared across the
// concurrent test runner, so identical secret bytes in different files
// would cross-pollute identity resolution.
const ownerSecret = new Uint8Array(32).fill(61);
const botRealSecret = new Uint8Array(32).fill(62);
const wsKeySecret = new Uint8Array(32).fill(63);
const orphanBotSecret = new Uint8Array(32).fill(64);
const orphanWsKeySecret = new Uint8Array(32).fill(65);
const canonicalWsKeySecret = new Uint8Array(32).fill(66);
const matchingAliasWsKeySecret = new Uint8Array(32).fill(67);
const ownerWsKeySecret = new Uint8Array(32).fill(68);
const unregisteredWsKeySecret = new Uint8Array(32).fill(69);
const ownerWsKeyV2Secret = new Uint8Array(32).fill(70);
const ownerDeviceSecret = new Uint8Array(32).fill(71);

const WORKSPACE_OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const BOT_REAL = nip19.npubEncode(getPublicKey(botRealSecret));
const BOT_WS_KEY = nip19.npubEncode(getPublicKey(wsKeySecret));
const ORPHAN_BOT_REAL = nip19.npubEncode(getPublicKey(orphanBotSecret));
const ORPHAN_BOT_WS_KEY = nip19.npubEncode(getPublicKey(orphanWsKeySecret));
const BOT_CANONICAL_WS_KEY = nip19.npubEncode(getPublicKey(canonicalWsKeySecret));
const BOT_MATCHING_ALIAS_WS_KEY = nip19.npubEncode(getPublicKey(matchingAliasWsKeySecret));
const OWNER_WS_KEY = nip19.npubEncode(getPublicKey(ownerWsKeySecret));
const UNREGISTERED_WS_KEY = nip19.npubEncode(getPublicKey(unregisteredWsKeySecret));
const OWNER_WS_KEY_V2 = nip19.npubEncode(getPublicKey(ownerWsKeyV2Secret));
const OWNER_DEVICE = nip19.npubEncode(getPublicKey(ownerDeviceSecret));
const TRIGGER_FAMILY = 'wingman-fd:agent_chat_trigger';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: unknown) {
  const url = `http://localhost${path}`;
  const tags: string[][] = [
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

describe('Phase 1 bot workspace-key contract', () => {
  let groupId: string;

  test('setup: workspace + group with bot member', async () => {
    const wsPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      name: 'Bot Key Test',
      description: '',
      wrapped_workspace_nsec: 'wrapped',
      wrapped_by_npub: WORKSPACE_OWNER,
      default_group_npub: 'npub1botkey_default',
      default_group_name: 'Shared',
      default_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 's', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      admin_group_npub: 'npub1botkey_admin',
      admin_group_name: 'Admins',
      admin_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 's', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      private_group_npub: 'npub1botkey_private',
      private_group_name: 'Private',
      private_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 's', wrapped_by_npub: WORKSPACE_OWNER },
      ],
    };
    const wsRes = await app.request('/api/v4/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/workspaces', 'POST', ownerSecret, wsPayload),
      },
      body: JSON.stringify(wsPayload),
    });
    expect(wsRes.status).toBe(201);

    const groupPayload = {
      owner_npub: WORKSPACE_OWNER,
      name: 'Chat',
      group_npub: 'npub1botkey_chat',
      member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'wrapped-owner', wrapped_by_npub: WORKSPACE_OWNER },
        { member_npub: BOT_REAL, wrapped_group_nsec: 'wrapped-bot', wrapped_by_npub: WORKSPACE_OWNER },
      ],
    };
    const groupRes = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', ownerSecret, groupPayload),
      },
      body: JSON.stringify(groupPayload),
    });
    expect(groupRes.status).toBe(201);
    groupId = (await groupRes.json()).group_id;
  });

  test('bot can register a ws_key_npub for an accessible workspace', async () => {
    const payload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      ws_key_npub: BOT_WS_KEY,
    };
    const res = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', botRealSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.ws_key_npub).toBe(BOT_WS_KEY);
    expect(body.active).toBe(true);
  });

  test('workspace owner can sync with canonical delegated workspace user key fields', async () => {
    const registerPayload = {
      workspace_service_npub: WORKSPACE_OWNER,
      workspace_user_key_npub: OWNER_WS_KEY,
    };
    const registerRes = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', ownerSecret, registerPayload),
      },
      body: JSON.stringify(registerPayload),
    });
    expect(registerRes.status).toBe(201);

    const syncPayload = {
      owner_npub: WORKSPACE_OWNER,
      workspace_service_npub: WORKSPACE_OWNER,
      user_npub: WORKSPACE_OWNER,
      actor_npub: WORKSPACE_OWNER,
      viewer_npub: WORKSPACE_OWNER,
      signer_npub: OWNER_WS_KEY,
      ws_key_npub: OWNER_WS_KEY,
      workspace_user_key_npub: OWNER_WS_KEY,
      records: [
        {
          record_id: 'owner-canonical-delegated-sync',
          owner_npub: WORKSPACE_OWNER,
          workspace_service_npub: WORKSPACE_OWNER,
          record_family_hash: TRIGGER_FAMILY,
          version: 1,
          previous_version: 0,
          signature_npub: OWNER_WS_KEY,
          owner_payload: { ciphertext: 'owner_canonical_delegated_sync' },
        },
      ],
    };
    const syncRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerWsKeySecret, syncPayload),
      },
      body: JSON.stringify(syncPayload),
    });
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.synced).toBe(1);
    expect(syncBody.rejected).toHaveLength(0);

    const registered = await registerRes.json();
    expect(registered.user_npub).toBe(WORKSPACE_OWNER);
    expect(registered.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(registered.workspace_user_key_npub).toBe(OWNER_WS_KEY);
  });

  test('canonical delegated sync rejects mismatched user_npub clearly', async () => {
    const syncPayload = {
      workspace_service_npub: WORKSPACE_OWNER,
      user_npub: BOT_REAL,
      actor_npub: BOT_REAL,
      viewer_npub: BOT_REAL,
      signer_npub: OWNER_WS_KEY,
      workspace_user_key_npub: OWNER_WS_KEY,
      records: [
        {
          record_id: 'owner-canonical-mismatched-user',
          workspace_service_npub: WORKSPACE_OWNER,
          record_family_hash: TRIGGER_FAMILY,
          version: 1,
          previous_version: 0,
          signature_npub: OWNER_WS_KEY,
          owner_payload: { ciphertext: 'owner_canonical_mismatched_user' },
        },
      ],
    };
    const syncRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerWsKeySecret, syncPayload),
      },
      body: JSON.stringify(syncPayload),
    });
    expect(syncRes.status).toBe(403);
    const body = await syncRes.json();
    expect(body.error).toContain('must match resolved authenticated user_npub');
  });

  test('rotating a canonical workspace user key revokes the old key for delegated reads', async () => {
    const rotatePayload = {
      workspace_service_npub: WORKSPACE_OWNER,
      old_workspace_user_key_npub: OWNER_WS_KEY,
      new_workspace_user_key_npub: OWNER_WS_KEY_V2,
    };
    const rotateRes = await app.request('/api/v4/user/workspace-keys/rotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys/rotate', 'POST', ownerSecret, rotatePayload),
      },
      body: JSON.stringify(rotatePayload),
    });
    expect(rotateRes.status).toBe(200);
    const rotateBody = await rotateRes.json();
    expect(rotateBody.user_npub).toBe(WORKSPACE_OWNER);
    expect(rotateBody.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(rotateBody.workspace_user_key_npub).toBe(OWNER_WS_KEY_V2);
    expect(rotateBody.active).toBe(true);

    const revokedPath = `/api/v4/records?workspace_service_npub=${WORKSPACE_OWNER}&workspace_user_key_npub=${OWNER_WS_KEY}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const revokedRes = await app.request(revokedPath, {
      headers: {
        Authorization: authHeader(revokedPath, 'GET', ownerWsKeySecret),
      },
    });
    expect(revokedRes.status).toBe(403);
    const revokedBody = await revokedRes.json();
    expect(revokedBody.code).toBe('workspace_key_revoked');
    expect(revokedBody.user_npub).toBe(WORKSPACE_OWNER);
    expect(revokedBody.signer_npub).toBe(OWNER_WS_KEY);
    expect(revokedBody.workspace_user_key_npub).toBe(OWNER_WS_KEY);
  });

  test('bot can register with workspace_service_npub and workspace_user_key_npub aliases', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      workspace_user_key_npub: BOT_CANONICAL_WS_KEY,
    };
    const res = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', botRealSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(body.ws_key_npub).toBe(BOT_CANONICAL_WS_KEY);
    expect(body.workspace_user_key_npub).toBe(BOT_CANONICAL_WS_KEY);
  });

  test('bot can register when legacy and canonical workspace key aliases match', async () => {
    const payload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      workspace_service_npub: WORKSPACE_OWNER,
      ws_key_npub: BOT_MATCHING_ALIAS_WS_KEY,
      workspace_user_key_npub: BOT_MATCHING_ALIAS_WS_KEY,
    };
    const res = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', botRealSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(body.workspace_user_key_npub).toBe(BOT_MATCHING_ALIAS_WS_KEY);
  });

  test('workspace key list returns canonical and legacy aliases plus user_npub', async () => {
    const res = await app.request('/api/v4/user/workspace-keys', {
      headers: {
        Authorization: authHeader('/api/v4/user/workspace-keys', 'GET', botRealSecret),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const key = body.keys.find((entry: any) => entry.workspace_user_key_npub === BOT_WS_KEY);
    expect(key).toBeDefined();
    expect(key.user_npub).toBe(BOT_REAL);
    expect(key.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(key.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(key.ws_key_npub).toBe(BOT_WS_KEY);
  });

  test('workspace key mappings return canonical and legacy aliases plus user_npub', async () => {
    const path = `/api/v4/user/workspace-key-mappings?workspace_service_npub=${WORKSPACE_OWNER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', wsKeySecret),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const mapping = body.mappings.find((entry: any) => entry.workspace_user_key_npub === BOT_WS_KEY);
    expect(mapping).toBeDefined();
    expect(mapping.user_npub).toBe(BOT_REAL);
    expect(mapping.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(mapping.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(mapping.ws_key_npub).toBe(BOT_WS_KEY);
  });

  test('device routes register, list, touch, and revoke a Nostr device key', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      device_npub: OWNER_DEVICE,
      label: 'MacBook Pro',
      platform: 'macos',
      policy: {
        tower_nip98: true,
        wapp_nip98: true,
      },
    };
    const createRes = await app.request('/api/v4/user/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/devices', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.device.device_npub).toBe(OWNER_DEVICE);
    expect(created.device.label).toBe('MacBook Pro');
    expect(created.device.platform).toBe('macos');
    expect(created.device.policy.tower_nip98).toBe(true);
    expect(created.device.status).toBe('active');

    const listRes = await app.request('/api/v4/user/devices', {
      headers: {
        Authorization: authHeader('/api/v4/user/devices', 'GET', ownerSecret),
      },
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.devices.map((device: any) => device.device_npub)).toContain(OWNER_DEVICE);

    const seenPayload = { workspace_service_npub: WORKSPACE_OWNER };
    const seenPath = `/api/v4/user/devices/${OWNER_DEVICE}/seen`;
    const seenRes = await app.request(seenPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(seenPath, 'POST', ownerSecret, seenPayload),
      },
      body: JSON.stringify(seenPayload),
    });
    expect(seenRes.status).toBe(200);
    const seen = await seenRes.json();
    expect(seen.device.last_seen_at).toBeTruthy();

    const revokePath = `/api/v4/user/devices/${OWNER_DEVICE}/revoke`;
    const revokePayload = {};
    const revokeRes = await app.request(revokePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(revokePath, 'POST', ownerSecret, revokePayload),
      },
      body: JSON.stringify(revokePayload),
    });
    expect(revokeRes.status).toBe(200);
    const revoked = await revokeRes.json();
    expect(revoked.device.status).toBe('revoked');
    expect(revoked.device.active).toBe(false);

    const mappingsPath = `/api/v4/user/workspace-key-mappings?workspace_service_npub=${WORKSPACE_OWNER}`;
    const revokedKeyMappings = await app.request(mappingsPath, {
      headers: {
        Authorization: authHeader(mappingsPath, 'GET', ownerSecret),
      },
    });
    expect(revokedKeyMappings.status).toBe(200);
    const mappings = await revokedKeyMappings.json();
    expect(mappings.mappings.map((mapping: any) => mapping.workspace_user_key_npub)).not.toContain(OWNER_DEVICE);
  });

  test('bot workspace-key registration rejects mismatched workspace_user_key aliases', async () => {
    const payload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      ws_key_npub: BOT_WS_KEY,
      workspace_user_key_npub: BOT_CANONICAL_WS_KEY,
    };
    const res = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', botRealSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('identity_alias_mismatch');
    expect(body.error).toContain('ws_key_npub');
    expect(body.error).toContain('workspace_user_key_npub');
  });

  test('bot signing with ws_key can fetch its wrapped group keys', async () => {
    // Resolved auth must map BOT_WS_KEY → BOT_REAL, and the route accepts
    // member_npub matching either the signer or the resolved identity.
    const path = `/api/v4/groups/keys?member_npub=${BOT_REAL}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', wsKeySecret),
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    const k = body.keys.find((row: any) => row.group_id === groupId);
    expect(k).toBeDefined();
    expect(k.member_npub).toBe(BOT_REAL);
    expect(k.wrapped_group_nsec).toBe('wrapped-bot');
  });

  test('bot signing with ws_key can also pass member_npub == ws_key_npub', async () => {
    const path = `/api/v4/groups/keys?member_npub=${BOT_WS_KEY}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', wsKeySecret),
      },
    });
    expect(res.status).toBe(200);
  });

  test('orphan bot: member of group with no wrapped key returns diagnostic failure', async () => {
    // Insert a v4_group_members row WITHOUT a wrapped key, simulating a
    // misconfigured bot that is "in" the group but cannot decrypt anything.
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${groupId}, ${ORPHAN_BOT_REAL})
    `;

    // Register orphan ws_key against this workspace so the resolved-auth path
    // maps the signer to ORPHAN_BOT_REAL.
    const regPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      ws_key_npub: ORPHAN_BOT_WS_KEY,
    };
    const regRes = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', orphanBotSecret, regPayload),
      },
      body: JSON.stringify(regPayload),
    });
    expect(regRes.status).toBe(201);

    const path = `/api/v4/groups/keys?member_npub=${ORPHAN_BOT_REAL}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', orphanWsKeySecret),
      },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('group_key_missing');
    expect(body.error).toContain('missing wrapped group keys');
    expect(body.actor_npub).toBe(ORPHAN_BOT_REAL);
    expect(body.ws_key_npub).toBe(ORPHAN_BOT_WS_KEY);
    expect(body.details.missing_groups[0].group_id).toBe(groupId);
  });

  test('bot ws_key can fetch the trigger record through the generic records path with audit fields', async () => {
    const recordId = 'agent-chat-trigger-workspace';
    const syncPayload = {
      owner_npub: WORKSPACE_OWNER,
      records: [
        {
          record_id: recordId,
          owner_npub: WORKSPACE_OWNER,
          record_family_hash: TRIGGER_FAMILY,
          version: 1,
          previous_version: 0,
          signature_npub: WORKSPACE_OWNER,
          owner_payload: { ciphertext: 'owner_trigger_ciphertext_v1' },
          group_payloads: [
            {
              group_id: groupId,
              group_epoch: 1,
              group_npub: 'npub1botkey_chat',
              ciphertext: 'bot_trigger_ciphertext_v1',
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

    const fetchPath = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const fetchRes = await app.request(fetchPath, {
      headers: {
        Authorization: authHeader(fetchPath, 'GET', wsKeySecret),
      },
    });
    expect(fetchRes.status).toBe(200);

    const fetchBody = await fetchRes.json();
    expect(fetchBody.audit.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(fetchBody.audit.actor_npub).toBe(BOT_REAL);
    expect(fetchBody.audit.ws_key_npub).toBe(BOT_WS_KEY);
    expect(fetchBody.records).toHaveLength(1);
    expect(fetchBody.records[0].record_id).toBe(recordId);
    expect(fetchBody.records[0].record_family_hash).toBe(TRIGGER_FAMILY);
    expect(fetchBody.records[0].group_payloads[0].group_id).toBe(groupId);

    const historyPath = `/api/v4/records/${recordId}/history?owner_npub=${WORKSPACE_OWNER}`;
    const historyRes = await app.request(historyPath, {
      headers: {
        Authorization: authHeader(historyPath, 'GET', wsKeySecret),
      },
    });
    expect(historyRes.status).toBe(200);

    const historyBody = await historyRes.json();
    expect(historyBody.audit.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(historyBody.audit.actor_npub).toBe(BOT_REAL);
    expect(historyBody.audit.ws_key_npub).toBe(BOT_WS_KEY);
    expect(historyBody.versions).toHaveLength(1);
    expect(historyBody.versions[0].record_id).toBe(recordId);
  });

  test('canonical workspace user key read uses user_npub for visibility and audit viewer', async () => {
    const fetchPath = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&viewer_npub=${BOT_WS_KEY}&workspace_user_key_npub=${BOT_WS_KEY}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const fetchRes = await app.request(fetchPath, {
      headers: {
        Authorization: authHeader(fetchPath, 'GET', wsKeySecret),
      },
    });
    expect(fetchRes.status).toBe(200);
    const fetchBody = await fetchRes.json();
    expect(fetchBody.audit.user_npub).toBe(BOT_REAL);
    expect(fetchBody.audit.viewer_npub).toBe(BOT_REAL);
    expect(fetchBody.audit.workspace_user_key_npub).toBe(BOT_WS_KEY);
    expect(fetchBody.records.some((record: any) => record.record_id === 'agent-chat-trigger-workspace')).toBe(true);
  });

  test('canonical workspace user key read rejects signer mismatch', async () => {
    const path = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&workspace_user_key_npub=${BOT_WS_KEY}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', botRealSecret),
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_key_invalid');
    expect(body.error).toContain('signer_npub must match workspace_user_key_npub');
  });

  test('canonical workspace user key read rejects unregistered key clearly', async () => {
    const path = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&workspace_user_key_npub=${UNREGISTERED_WS_KEY}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', unregisteredWsKeySecret),
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_key_invalid');
    expect(body.error).toContain('not registered');
  });

  test('canonical workspace user key read rejects mismatched workspace service clearly', async () => {
    const path = `/api/v4/records?workspace_service_npub=${BOT_REAL}&workspace_user_key_npub=${BOT_WS_KEY}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', wsKeySecret),
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_key_invalid');
    expect(body.workspace_service_npub).toBe(BOT_REAL);
    expect(body.workspace_user_key_npub).toBe(BOT_WS_KEY);
    expect(body.signer_npub).toBe(BOT_WS_KEY);
    expect(body.user_npub).toBe(BOT_REAL);
  });

  test('canonical workspace user key read rejects inactive key clearly', async () => {
    await sql`
      UPDATE user_workspace_keys
      SET active = false
      WHERE workspace_owner_npub = ${WORKSPACE_OWNER}
        AND ws_key_npub = ${BOT_CANONICAL_WS_KEY}
    `;

    const path = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&workspace_user_key_npub=${BOT_CANONICAL_WS_KEY}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', canonicalWsKeySecret),
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('workspace_key_revoked');
    expect(body.error).toContain('inactive');
  });
});
