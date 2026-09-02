import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_agent_chat_failures';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

const ownerSecret = new Uint8Array(32).fill(71);
const botRealSecret = new Uint8Array(32).fill(72);
const wsKeySecret = new Uint8Array(32).fill(73);
const newWsKeySecret = new Uint8Array(32).fill(74);
const outsiderRealSecret = new Uint8Array(32).fill(75);
const outsiderWsKeySecret = new Uint8Array(32).fill(76);

const WORKSPACE_OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const BOT_REAL = nip19.npubEncode(getPublicKey(botRealSecret));
const BOT_WS_KEY = nip19.npubEncode(getPublicKey(wsKeySecret));
const BOT_WS_KEY_V2 = nip19.npubEncode(getPublicKey(newWsKeySecret));
const OUTSIDER_REAL = nip19.npubEncode(getPublicKey(outsiderRealSecret));
const OUTSIDER_WS_KEY = nip19.npubEncode(getPublicKey(outsiderWsKeySecret));

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

function streamToken(streamPath: string, secret: Uint8Array): string {
  const url = `http://localhost${streamPath}`;
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', 'GET']],
    content: '',
  }, secret);
  return Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
}

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
  clearWsKeyCacheForTests();
  if (sql) await sql.end();
});

describe('Phase 4 agent chat failure signals', () => {
  let groupId = '';

  test('setup: workspace, chat group, bot ws_key, and one visible record', async () => {
    const wsPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      name: 'Agent Chat Failure Signals',
      description: '',
      wrapped_workspace_nsec: 'wrapped',
      wrapped_by_npub: WORKSPACE_OWNER,
      default_group_npub: 'npub1phase4_default',
      default_group_name: 'Shared',
      default_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'shared-owner', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      admin_group_npub: 'npub1phase4_admin',
      admin_group_name: 'Admins',
      admin_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'admin-owner', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      private_group_npub: 'npub1phase4_private',
      private_group_name: 'Private',
      private_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'private-owner', wrapped_by_npub: WORKSPACE_OWNER },
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
      group_npub: 'npub1phase4_chat',
      member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'chat-owner', wrapped_by_npub: WORKSPACE_OWNER },
        { member_npub: BOT_REAL, wrapped_group_nsec: 'chat-bot', wrapped_by_npub: WORKSPACE_OWNER },
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

    const regPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      ws_key_npub: BOT_WS_KEY,
    };
    const regRes = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', botRealSecret, regPayload),
      },
      body: JSON.stringify(regPayload),
    });
    expect(regRes.status).toBe(201);

    const syncPayload = {
      owner_npub: WORKSPACE_OWNER,
      records: [
        {
          record_id: 'phase4-chat-record',
          owner_npub: WORKSPACE_OWNER,
          record_family_hash: 'wingman-fd:chat_message',
          version: 1,
          previous_version: 0,
          signature_npub: WORKSPACE_OWNER,
          owner_payload: { ciphertext: 'owner-chat-record' },
          group_payloads: [
            {
              group_id: groupId,
              group_epoch: 1,
              group_npub: 'npub1phase4_chat',
              ciphertext: 'bot-chat-record',
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
  });

  test('revoked ws_key is explicit on record pulls', async () => {
    const rotatePayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      old_ws_key_npub: BOT_WS_KEY,
      new_ws_key_npub: BOT_WS_KEY_V2,
    };
    const rotateRes = await app.request('/api/v4/user/workspace-keys/rotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys/rotate', 'POST', botRealSecret, rotatePayload),
      },
      body: JSON.stringify(rotatePayload),
    });
    expect(rotateRes.status).toBe(200);

    const fetchPath = `/api/v4/records?owner_npub=${WORKSPACE_OWNER}&record_family_hash=${encodeURIComponent('wingman-fd:chat_message')}`;
    const fetchRes = await app.request(fetchPath, {
      headers: {
        Authorization: authHeader(fetchPath, 'GET', wsKeySecret),
      },
    });
    expect(fetchRes.status).toBe(403);
    const body = await fetchRes.json();
    expect(body.code).toBe('record_pull_forbidden');
    expect(body.reason_code).toBe('workspace_key_revoked');
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.actor_npub).toBe(BOT_REAL);
    expect(body.ws_key_npub).toBe(BOT_WS_KEY);
  });

  test('record history not-found is explicit after access checks pass', async () => {
    const path = `/api/v4/records/nonexistent-phase4/history?owner_npub=${WORKSPACE_OWNER}`;
    const res = await app.request(path, {
      headers: {
        Authorization: authHeader(path, 'GET', newWsKeySecret),
      },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('record_pull_not_found');
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
  });

  test('non-owner SSE without ws_key is explicit', async () => {
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const res = await app.request(`${path}?token=${encodeURIComponent(streamToken(path, botRealSecret))}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('sse_stream_forbidden');
    expect(body.reason_code).toBe('workspace_key_missing');
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
  });

  test('stale group epoch is explicit on wrapped-key refresh', async () => {
    await sql`
      INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
      VALUES (${groupId}, 2, ${'npub1phase4_chat_epoch2'}, ${WORKSPACE_OWNER})
    `;
    await sql`
      UPDATE v4_groups
      SET group_npub = ${'npub1phase4_chat_epoch2'}
      WHERE id = ${groupId}
    `;

    const keysPath = `/api/v4/groups/keys?member_npub=${BOT_REAL}`;
    const keysRes = await app.request(keysPath, {
      headers: {
        Authorization: authHeader(keysPath, 'GET', newWsKeySecret),
      },
    });
    expect(keysRes.status).toBe(409);
    const body = await keysRes.json();
    expect(body.code).toBe('group_key_epoch_stale');
    expect(body.details.stale_groups[0].group_id).toBe(groupId);
    expect(body.details.stale_groups[0].current_epoch).toBe(2);
    expect(body.details.stale_groups[0].latest_key_version).toBe(1);
  });

  test('missing wrapped group key is explicit on wrapped-key refresh', async () => {
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${groupId}, ${OUTSIDER_REAL})
      ON CONFLICT (group_id, member_npub) DO NOTHING
    `;
    const regPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      ws_key_npub: OUTSIDER_WS_KEY,
    };
    const regRes = await app.request('/api/v4/user/workspace-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/user/workspace-keys', 'POST', outsiderRealSecret, regPayload),
      },
      body: JSON.stringify(regPayload),
    });
    expect(regRes.status).toBe(201);

    const keysPath = `/api/v4/groups/keys?member_npub=${OUTSIDER_REAL}`;
    const keysRes = await app.request(keysPath, {
      headers: {
        Authorization: authHeader(keysPath, 'GET', outsiderWsKeySecret),
      },
    });
    expect(keysRes.status).toBe(409);
    const body = await keysRes.json();
    expect(body.code).toBe('group_key_missing');
    expect(body.details.missing_groups[0].group_id).toBe(groupId);
  });

  test('membership revocation is explicit on group-key refresh and SSE reconnect', async () => {
    const removePath = `/api/v4/groups/${groupId}/members/${BOT_REAL}`;
    const removeRes = await app.request(removePath, {
      method: 'DELETE',
      headers: {
        Authorization: authHeader(removePath, 'DELETE', ownerSecret),
      },
    });
    expect(removeRes.status).toBe(200);

    const keysPath = `/api/v4/groups/keys?member_npub=${BOT_REAL}`;
    const keysRes = await app.request(keysPath, {
      headers: {
        Authorization: authHeader(keysPath, 'GET', newWsKeySecret),
      },
    });
    expect(keysRes.status).toBe(403);
    const keysBody = await keysRes.json();
    expect(keysBody.code).toBe('group_membership_revoked');
    expect(keysBody.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(keysBody.actor_npub).toBe(BOT_REAL);
    expect(keysBody.ws_key_npub).toBe(BOT_WS_KEY_V2);

    const streamPath = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const streamRes = await app.request(`${streamPath}?token=${encodeURIComponent(streamToken(streamPath, newWsKeySecret))}`);
    expect(streamRes.status).toBe(403);
    const streamBody = await streamRes.json();
    expect(streamBody.code).toBe('sse_stream_forbidden');
    expect(streamBody.reason_code).toBe('group_membership_revoked');
  });
});
