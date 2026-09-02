/**
 * Phase 1 actor-visible SSE access tests.
 *
 * Locks the authorization rule for GET /api/v4/workspaces/:ownerNpub/stream:
 *   1. workspace owner subscribing directly is allowed
 *   2. a bot signing with a registered ws_key_npub for that workspace AND
 *      who is a current group member is allowed
 *   3. an unrelated subscriber (no ws_key for the workspace) is rejected
 *      before the stream opens
 *   4. a bot that has been removed from all readable groups in that
 *      workspace loses stream access on reconnect
 *
 * Tests assert response status only and immediately cancel any opened body
 * to clear sseHub timers so the bun test runner can exit cleanly.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { sseHub } from '../src/sse-hub';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_stream_access';

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

afterEach(() => {
  // Clean up any clients/timers added during a successful subscribe; cancel()
  // on the response body should already trigger removeClient, but defensively
  // close anything still attached so timers do not keep the process alive.
  const ownerNpubs = [WORKSPACE_OWNER];
  for (const owner of ownerNpubs) {
    while (sseHub.getClientCount(owner) > 0) {
      // No public list API; rely on cancel() in tests. This loop is a guard.
      break;
    }
  }
});

// Byte fills 51..54 chosen to avoid collision with any other test file's
// secrets — the module-level ws_key resolution cache is shared across the
// concurrent test runner, so identical secret bytes in different files
// would cross-pollute identity resolution.
const ownerSecret = new Uint8Array(32).fill(51);
const wsKeySecret = new Uint8Array(32).fill(52); // bot's workspace session key
const botRealSecret = new Uint8Array(32).fill(53); // bot's real identity (used to register ws key)
const outsiderSecret = new Uint8Array(32).fill(54);

const WORKSPACE_OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const BOT_REAL = nip19.npubEncode(getPublicKey(botRealSecret));
const BOT_WS_KEY = nip19.npubEncode(getPublicKey(wsKeySecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));

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

/** Build a base64 NIP-98 token suitable for the stream ?token= query param. */
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

async function streamRequest(token: string, semanticQuery = '') {
  const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
  const prefix = semanticQuery ? `${semanticQuery}&` : '';
  return app.request(`${path}?${prefix}token=${encodeURIComponent(token)}`, {
    method: 'GET',
  });
}

async function cancelBody(res: Response) {
  try {
    await res.body?.cancel();
  } catch {
    // ignore
  }
}

describe('Phase 1 actor-visible SSE access', () => {
  let groupId: string;

  test('setup: create workspace, group with bot member, register bot ws_key', async () => {
    // 1. Owner creates a workspace where workspace_owner_npub == OWNER (signing) npub.
    const wsPayload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      name: 'Bot Stream Test',
      description: '',
      wrapped_workspace_nsec: 'wrapped-workspace-nsec',
      wrapped_by_npub: WORKSPACE_OWNER,
      default_group_npub: 'npub1streamtest_default_group',
      default_group_name: 'Shared',
      default_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'wsec', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      admin_group_npub: 'npub1streamtest_admin_group',
      admin_group_name: 'Admins',
      admin_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'asec', wrapped_by_npub: WORKSPACE_OWNER },
      ],
      private_group_npub: 'npub1streamtest_private_group',
      private_group_name: 'Private',
      private_group_member_keys: [
        { member_npub: WORKSPACE_OWNER, wrapped_group_nsec: 'psec', wrapped_by_npub: WORKSPACE_OWNER },
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

    // 2. Owner creates a chat group whose members include the bot's real npub.
    const groupPayload = {
      owner_npub: WORKSPACE_OWNER,
      name: 'Chat',
      group_npub: 'npub1streamtest_chat_group',
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

    // 3. Bot registers its workspace session key — signs with its REAL identity.
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
  });

  test('owner subscribing directly is allowed', async () => {
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(path, ownerSecret);
    const res = await streamRequest(token);
    expect(res.status).toBe(200);
    await cancelBody(res);
  });

  test('requires exactly one non-empty transport token', async () => {
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(path, ownerSecret);
    const missing = await app.request(path);
    expect(missing.status).toBe(401);
    const empty = await app.request(`${path}?token=`);
    expect(empty.status).toBe(401);
    const duplicate = await app.request(
      `${path}?token=${encodeURIComponent(token)}&token=${encodeURIComponent(token)}`,
    );
    expect(duplicate.status).toBe(401);
  });

  test('signs last_event_id exactly and rejects cursor changes', async () => {
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(`${path}?last_event_id=10`, ownerSecret);
    const exact = await streamRequest(token, 'last_event_id=10');
    expect(exact.status).toBe(200);
    await cancelBody(exact);

    const changed = await streamRequest(token, 'last_event_id=11');
    expect(changed.status).toBe(401);
    const missing = await streamRequest(token);
    expect(missing.status).toBe(401);
  });

  test('bot signing with registered ws_key and group membership is allowed', async () => {
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(path, wsKeySecret);
    const res = await streamRequest(token);
    expect(res.status).toBe(200);
    await cancelBody(res);
  });

  test('unrelated subscriber is rejected before the stream opens', async () => {
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(path, outsiderSecret);
    const res = await streamRequest(token);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text.toLowerCase()).toContain('forbidden');
  });

  test('bot signing with its real identity (no ws_key registration) is rejected', async () => {
    // Bot's real npub is a group member, but the rule requires the SIGNER to
    // be a registered ws_key_npub for the workspace. Direct-signing as the
    // real bot identity must be rejected.
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(path, botRealSecret);
    const res = await streamRequest(token);
    expect(res.status).toBe(403);
  });

  test('removed bot loses stream access on reconnect', async () => {
    // Remove the bot from the only group it belongs to in this workspace.
    const delPath = `/api/v4/groups/${groupId}/members/${BOT_REAL}`;
    const delRes = await app.request(delPath, {
      method: 'DELETE',
      headers: {
        Authorization: authHeader(delPath, 'DELETE', ownerSecret),
      },
    });
    expect(delRes.status).toBe(200);

    // The ws_key registration still exists, but the actor is no longer a
    // current member of any readable group → must be rejected on reconnect.
    const path = `/api/v4/workspaces/${WORKSPACE_OWNER}/stream`;
    const token = streamToken(path, wsKeySecret);
    const res = await streamRequest(token);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('no_group_membership');
  });
});
