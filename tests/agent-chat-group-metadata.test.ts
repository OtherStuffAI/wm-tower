import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_agent_chat_group_metadata';

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
  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  app = createApp();
});

afterAll(async () => {
  clearWsKeyCacheForTests();
  if (sql) await sql.end();
});

const ownerSecret = new Uint8Array(32).fill(71);
const botRealSecret = new Uint8Array(32).fill(72);
const wsKeySecret = new Uint8Array(32).fill(73);

const WORKSPACE_OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const BOT_REAL = nip19.npubEncode(getPublicKey(botRealSecret));
const BOT_WS_KEY = nip19.npubEncode(getPublicKey(wsKeySecret));

const CHAT_FAMILY = 'wingman-fd:chat_message';
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

describe('Agent Chat group metadata contract', () => {
  test('Wingmen can resolve candidate chat groups from records plus generic group surfaces without a trigger record', async () => {
    const workspacePayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      name: 'Agent Chat Metadata',
      description: '',
      wrapped_workspace_nsec: 'wrapped-workspace',
      wrapped_by_npub: WORKSPACE_OWNER,
      default_group_npub: 'npub1wp22_default',
      default_group_name: 'Shared',
      default_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'shared-owner', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      admin_group_npub: 'npub1wp22_admin',
      admin_group_name: 'Admins',
      admin_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'admin-owner', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      private_group_npub: 'npub1wp22_private',
      private_group_name: 'Owner Private',
      private_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'private-owner', wrapped_by_npub: WORKSPACE_OWNER },
      ],
    };
    const workspaceRes = await app.request('/api/v4/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/workspaces', 'POST', ownerSecret, workspacePayload),
      },
      body: JSON.stringify(workspacePayload),
    });
    expect(workspaceRes.status).toBe(201);

    const groupPayload = {
      owner_npub: WORKSPACE_OWNER,
      name: 'Agent Channel',
      group_npub: 'npub1wp22_chat_epoch1',
      member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'chat-owner-epoch1', wrapped_by_npub: WORKSPACE_OWNER },
        { member_npub: BOT_REAL, wrapped_group_nsec: 'chat-bot-epoch1', wrapped_by_npub: WORKSPACE_OWNER },
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
    const groupBody = await groupRes.json();
    const groupId = groupBody.group_id;

    const wsKeyPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      ws_key_npub: BOT_WS_KEY,
    };
    const wsKeyRes = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', botRealSecret, wsKeyPayload),
      },
      body: JSON.stringify(wsKeyPayload),
    });
    expect(wsKeyRes.status).toBe(201);

    const syncV1Payload = {
      owner_npub: WORKSPACE_OWNER,
      records: [
        {
          record_id: 'chat-msg-001',
          owner_npub: WORKSPACE_OWNER,
          record_family_hash: CHAT_FAMILY,
          version: 1,
          previous_version: 0,
          signature_npub: WORKSPACE_OWNER,
          owner_payload: { ciphertext: 'owner-chat-v1' },
          group_payloads: [
            {
              group_id: groupId,
              group_epoch: 1,
              group_npub: groupBody.group_npub,
              ciphertext: 'chat-group-v1',
              write: false,
            },
          ],
        },
      ],
    };
    const syncV1Res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, syncV1Payload),
      },
      body: JSON.stringify(syncV1Payload),
    });
    expect(syncV1Res.status).toBe(200);

    const triggerFetchPath = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&record_family_hash=${encodeURIComponent(TRIGGER_FAMILY)}`;
    const triggerFetchRes = await app.request(triggerFetchPath, {
      headers: {
        Authorization: authHeader(triggerFetchPath, 'GET', wsKeySecret),
      },
    });
    expect(triggerFetchRes.status).toBe(200);
    const triggerFetchBody = await triggerFetchRes.json();
    expect(triggerFetchBody.records).toHaveLength(0);

    const recordsPath = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&record_family_hash=${encodeURIComponent(CHAT_FAMILY)}`;
    const recordsRes = await app.request(recordsPath, {
      headers: {
        Authorization: authHeader(recordsPath, 'GET', wsKeySecret),
      },
    });
    expect(recordsRes.status).toBe(200);
    const recordsBody = await recordsRes.json();
    expect(recordsBody.audit.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(recordsBody.audit.actor_npub).toBe(BOT_REAL);
    expect(recordsBody.audit.ws_key_npub).toBe(BOT_WS_KEY);
    expect(recordsBody.records).toHaveLength(1);
    expect(recordsBody.records[0].record_id).toBe('chat-msg-001');
    expect(recordsBody.records[0].group_payloads).toEqual([
      expect.objectContaining({
        group_id: groupId,
        group_epoch: 1,
        group_npub: groupBody.group_npub,
        ciphertext: 'chat-group-v1',
        write: false,
      }),
    ]);

    const botGroupsPath = `/api/v4/groups?npub=${BOT_WS_KEY}`;
    const botGroupsRes = await app.request(botGroupsPath, {
      headers: {
        Authorization: authHeader(botGroupsPath, 'GET', wsKeySecret),
      },
    });
    expect(botGroupsRes.status).toBe(200);
    const botGroupsBody = await botGroupsRes.json();
    const chatGroup = botGroupsBody.groups.find((group: any) => group.id === groupId);
    expect(chatGroup).toBeDefined();
    expect(chatGroup.group_npub).toBe(groupBody.group_npub);
    expect(chatGroup.current_epoch).toBe(1);
    expect(chatGroup.group_kind).toBe('shared');
    expect(chatGroup.private_member_npub).toBeNull();

    const ownerGroupsPath = `/api/v4/groups?npub=${WORKSPACE_OWNER}`;
    const ownerGroupsRes = await app.request(ownerGroupsPath, {
      headers: {
        Authorization: authHeader(ownerGroupsPath, 'GET', ownerSecret),
      },
    });
    expect(ownerGroupsRes.status).toBe(200);
    const ownerGroupsBody = await ownerGroupsRes.json();
    const ownerPrivateGroup = ownerGroupsBody.groups.find((group: any) => group.group_kind === 'private');
    expect(ownerPrivateGroup).toBeDefined();
    expect(ownerPrivateGroup.private_member_npub).toBe(WORKSPACE_OWNER);

    const keysPath = `/api/v4/groups/keys?member_npub=${BOT_WS_KEY}`;
    const keysRes = await app.request(keysPath, {
      headers: {
        Authorization: authHeader(keysPath, 'GET', wsKeySecret),
      },
    });
    expect(keysRes.status).toBe(200);
    const keysBody = await keysRes.json();
    expect(keysBody.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group_id: groupId,
          group_npub: groupBody.group_npub,
          epoch: 1,
          member_npub: BOT_REAL,
          wrapped_group_nsec: 'chat-bot-epoch1',
          key_version: 1,
        }),
      ]),
    );

    const rotatePath = `/api/v4/groups/${groupId}/rotate`;
    const rotatePayload = {
      group_npub: 'npub1wp22_chat_epoch2',
      member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'chat-owner-epoch2', wrapped_by_npub: WORKSPACE_OWNER },
        { member_npub: BOT_REAL, wrapped_group_nsec: 'chat-bot-epoch2', wrapped_by_npub: WORKSPACE_OWNER },
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

    const syncV2Payload = {
      owner_npub: WORKSPACE_OWNER,
      records: [
        {
          record_id: 'chat-msg-001',
          owner_npub: WORKSPACE_OWNER,
          record_family_hash: CHAT_FAMILY,
          version: 2,
          previous_version: 1,
          signature_npub: WORKSPACE_OWNER,
          owner_payload: { ciphertext: 'owner-chat-v2' },
          group_payloads: [
            {
              group_id: groupId,
              group_epoch: 2,
              group_npub: rotateBody.group_npub,
              ciphertext: 'chat-group-v2',
              write: false,
            },
          ],
        },
      ],
    };
    const syncV2Res = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, syncV2Payload),
      },
      body: JSON.stringify(syncV2Payload),
    });
    expect(syncV2Res.status).toBe(200);

    const rotatedKeysRes = await app.request(keysPath, {
      headers: {
        Authorization: authHeader(keysPath, 'GET', wsKeySecret),
      },
    });
    expect(rotatedKeysRes.status).toBe(200);
    const rotatedKeysBody = await rotatedKeysRes.json();
    expect(rotatedKeysBody.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group_id: groupId, group_npub: groupBody.group_npub, epoch: 1, key_version: 1 }),
        expect.objectContaining({ group_id: groupId, group_npub: rotateBody.group_npub, epoch: 2, key_version: 2 }),
      ]),
    );

    const historyPath = `/api/v4/records/chat-msg-001/history?owner_npub=${WORKSPACE_OWNER}`;
    const historyRes = await app.request(historyPath, {
      headers: {
        Authorization: authHeader(historyPath, 'GET', wsKeySecret),
      },
    });
    expect(historyRes.status).toBe(200);
    const historyBody = await historyRes.json();
    expect(historyBody.versions).toHaveLength(2);
    expect(historyBody.versions[0].group_payloads).toEqual([
      expect.objectContaining({
        group_id: groupId,
        group_epoch: 2,
        group_npub: rotateBody.group_npub,
        ciphertext: 'chat-group-v2',
      }),
    ]);
    expect(historyBody.versions[1].group_payloads).toEqual([
      expect.objectContaining({
        group_id: groupId,
        group_epoch: 1,
        group_npub: groupBody.group_npub,
        ciphertext: 'chat-group-v1',
      }),
    ]);
  });
});
