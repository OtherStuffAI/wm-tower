import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import {
  completeStorageObject,
  enableInMemoryStorageForTest,
  resetInMemoryStorageForTest,
  writeStorageObject,
} from '../src/services/storage';
import type { FlightDeckPgContractFixture } from '../src/types';
import { FLIGHTDECK_PG_IDENTITY_ROTATION_KIND, FLIGHTDECK_PG_IDENTITY_ROTATION_PROTOCOL, rotationProofContent } from '../src/services/flightdeck-pg-identity-rotation';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_api';
const APP_NPUB = 'npub1flightdeckpgapitestapp';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

const ownerSecret = new Uint8Array(32).fill(31);
const memberSecret = new Uint8Array(32).fill(32);
const groupMemberSecret = new Uint8Array(32).fill(33);
const inviteeSecret = new Uint8Array(32).fill(34);
const adminSecret = new Uint8Array(32).fill(35);
const dmOnlySecret = new Uint8Array(32).fill(36);
const agentSecret = new Uint8Array(32).fill(37);
const inaccessibleAgentSecret = new Uint8Array(32).fill(38);
const humanDirectChatAgentSecret = new Uint8Array(32).fill(40);
const rotatedAgentSecret = new Uint8Array(32).fill(41);
const rotatingAgentSecret = new Uint8Array(32).fill(43);
const OWNER_NPUB = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER_NPUB = nip19.npubEncode(getPublicKey(memberSecret));
const GROUP_MEMBER_NPUB = nip19.npubEncode(getPublicKey(groupMemberSecret));
const INVITEE_NPUB = nip19.npubEncode(getPublicKey(inviteeSecret));
const ADMIN_NPUB = nip19.npubEncode(getPublicKey(adminSecret));
const DM_ONLY_NPUB = nip19.npubEncode(getPublicKey(dmOnlySecret));
const AGENT_NPUB = nip19.npubEncode(getPublicKey(agentSecret));
const INACCESSIBLE_AGENT_NPUB = nip19.npubEncode(getPublicKey(inaccessibleAgentSecret));
const HUMAN_DIRECT_CHAT_AGENT_NPUB = nip19.npubEncode(getPublicKey(humanDirectChatAgentSecret));
const ROTATED_AGENT_NPUB = nip19.npubEncode(getPublicKey(rotatedAgentSecret));
const ROTATING_AGENT_NPUB = nip19.npubEncode(getPublicKey(rotatingAgentSecret));
const UNKNOWN_AGENT_NPUB = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(39)));
const ORIGINAL_ADMIN_NPUB = config.adminNpub;

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: unknown) {
  const tags = [
    ['u', `http://localhost${path}`],
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

function messageSignature(input: { body: string; secret: Uint8Array; workspaceId: string; channelId: string; threadId?: string | null; messageId?: string; revision?: number }) {
  const bodyHash = sha256Hex(input.body);
  const tags = [
    ['protocol', 'flightdeck_pg_message_instruction'],
    ['body_sha256', bodyHash],
    ['workspace_id', input.workspaceId],
    ['channel_id', input.channelId],
  ];
  if (input.threadId) tags.push(['thread_id', input.threadId]);
  if (input.messageId) tags.push(['message_id', input.messageId]);
  if (input.revision !== undefined) tags.push(['revision', String(input.revision)]);
  const event = finalizeEvent({
    kind: 33358,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.body,
  }, input.secret);
  return {
    version: 1,
    signer_npub: nip19.npubEncode(getPublicKey(input.secret)),
    body_sha256: bodyHash,
    nostr_event: event,
  };
}

function identityRotationProof(input: { workspaceId: string; actorId: string; oldNpub: string; newNpub: string; rotationId: string; secret: Uint8Array; createdAt?: number; expiresAt?: number }) {
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = input.expiresAt ?? createdAt + 300;
  const towerOrigin = 'http://localhost';
  return finalizeEvent({
    kind: FLIGHTDECK_PG_IDENTITY_ROTATION_KIND,
    created_at: createdAt,
    tags: [
      ['protocol', FLIGHTDECK_PG_IDENTITY_ROTATION_PROTOCOL],
      ['tower_origin', towerOrigin],
      ['workspace_id', input.workspaceId],
      ['actor_id', input.actorId],
      ['old_npub', input.oldNpub],
      ['new_npub', input.newNpub],
      ['rotation_id', input.rotationId],
      ['expires_at', String(expiresAt)],
    ],
    content: rotationProofContent({ tower_origin: towerOrigin, workspace_id: input.workspaceId, actor_id: input.actorId, old_npub: input.oldNpub, new_npub: input.newNpub, rotation_id: input.rotationId, created_at: createdAt, expires_at: expiresAt }),
  }, input.secret);
}

async function requestJson(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  secret: Uint8Array,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
      Authorization: authHeader(path, method, secret, body),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { res, json };
}

async function requestRaw(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  secret: Uint8Array,
  headers: Record<string, string> = {},
) {
  const res = await app.request(path, {
    method,
    headers: {
      ...headers,
      Authorization: authHeader(path, method, secret),
    },
  });
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function readSsePreview(res: Response, predicate: (text: string) => boolean): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  const startedAt = Date.now();
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  while (!predicate(text) && Date.now() - startedAt < 2_000) {
    pendingRead ??= reader.read();
    const result = await Promise.race([
      pendingRead.then((read) => ({ kind: 'read' as const, read })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 250);
      }),
    ]);
    if (result.kind === 'timeout') continue;
    const { read } = result;
    pendingRead = null;
    if (read.done) break;
    text += decoder.decode(read.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

function splitSqlStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarQuote: string | null = null;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;

  for (let i = 0; i < migration.length; i += 1) {
    const char = migration[i];
    const next = migration[i + 1];

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        current += char;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && !dollarQuote && char === '-' && next === '-') {
      lineComment = true;
      i += 1;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && char === '$') {
      const match = migration.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        const tag = match[0];
        if (dollarQuote === tag) {
          dollarQuote = null;
        } else if (!dollarQuote) {
          dollarQuote = tag;
        }
        current += tag;
        i += tag.length - 1;
        continue;
      }
    }

    current += char;

    if (dollarQuote) continue;

    if (!doubleQuoted && char === "'" && migration[i - 1] !== '\\') {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && char === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function loadFixture(file: string): FlightDeckPgContractFixture {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'flightdeck-pg', file), 'utf8'));
}

function expectFixtureRequiredKeys(response: Record<string, unknown>, fixtureFile: string) {
  const fixture = loadFixture(fixtureFile);
  const required = fixture.response_shape.required as string[];
  for (const key of required) {
    expect(response[key]).toBeDefined();
  }
}

async function runMigrations() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
}

async function seedWorkspace(workspaceServiceNpub = 'npub1workspaceflightdeckpgapi') {
  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES (${OWNER_NPUB}, 'human', 'Owner')
    ON CONFLICT (npub) DO UPDATE SET
      kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name
    RETURNING id
  `;
  const [groupMember] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES (${GROUP_MEMBER_NPUB}, 'human', 'Group Member')
    ON CONFLICT (npub) DO UPDATE SET
      kind = EXCLUDED.kind,
      display_name = EXCLUDED.display_name
    RETURNING id
  `;
  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      description,
      created_by_actor_id
    )
    VALUES (
      'npub1towerflightdeckpgapi',
      ${workspaceServiceNpub},
      ${OWNER_NPUB},
      ${APP_NPUB},
      'Flight Deck PG API Test',
      'Runtime API fixture workspace',
      ${owner.id}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
    VALUES
      (${workspace.id}, ${owner.id}, 'owner', ${owner.id}),
      (${workspace.id}, ${groupMember.id}, 'member', ${owner.id})
  `;
  const [group] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, 'External Viewers', 'custom', ${owner.id})
    ON CONFLICT (workspace_id, name) DO UPDATE SET kind = EXCLUDED.kind
    RETURNING id
  `;
  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES (${workspace.id}, ${group.id}, ${groupMember.id}, ${owner.id})
  `;
  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_actor_id,
      resource_type,
      permission,
      created_by_actor_id
    )
    VALUES
      (${workspace.id}, 'actor', ${owner.id}, 'workspace', 'workspace.read', ${owner.id}),
      (${workspace.id}, 'actor', ${owner.id}, 'workspace', 'workspace.invite', ${owner.id}),
      (${workspace.id}, 'actor', ${owner.id}, 'workspace', 'workspace.manage', ${owner.id}),
      (${workspace.id}, 'actor', ${owner.id}, 'workspace', 'event_subscription.manage', ${owner.id}),
      (${workspace.id}, 'actor', ${owner.id}, 'workspace', 'scope.create', ${owner.id})
  `;
  return { workspaceId: workspace.id, ownerId: owner.id, groupMemberId: groupMember.id, groupId: group.id };
}

async function createCompletedDocStorageObject(input: { workspaceId: string; fileName: string; content: string }) {
  const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
    SELECT workspace_owner_npub FROM flightdeck_pg_workspaces WHERE id = ${input.workspaceId}
  `;
  const bytes = Buffer.from(input.content, 'utf8');
  const [object] = await sql<{ id: string }[]>`
    INSERT INTO v4_storage_objects (owner_npub, created_by_npub, file_name, content_type, size_bytes, storage_path)
    VALUES (${workspace.workspace_owner_npub}, ${OWNER_NPUB}, ${input.fileName}, 'text/markdown', ${bytes.byteLength}, ${`v4/flightdeck-pg/api/${input.fileName}-${randomUUID()}`})
    RETURNING id
  `;
  expect(await writeStorageObject(object.id, bytes, OWNER_NPUB)).not.toBeNull();
  expect(await completeStorageObject(object.id, { sha256_hex: sha256Hex(bytes), size_bytes: bytes.byteLength }, OWNER_NPUB)).not.toBeNull();
  return { id: object.id, bytes, sha256Hex: sha256Hex(bytes) };
}

beforeAll(async () => {
  const adminOpts: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };

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
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };

  sql = postgres(testOpts);
  setDb(sql);
  await runMigrations();
  config.adminNpub = ADMIN_NPUB;
  enableInMemoryStorageForTest();
  app = createApp();
});

afterAll(async () => {
  config.adminNpub = ORIGINAL_ADMIN_NPUB;
  resetInMemoryStorageForTest();
  await closeDb();
});

describe('Flight Deck PG API routes', () => {
  test('atomically rotates a global agent identity with dual proof and preserves actor relationships', async () => {
    const { workspaceId, ownerId } = await seedWorkspace('npub1workspaceidentityrotation');
    const [agent] = await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_actors(npub,kind,display_name) VALUES(${ROTATING_AGENT_NPUB},'agent','Rotating Agent') RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id) VALUES(${workspaceId},${agent.id},'agent',${ownerId})`;
    await sql`INSERT INTO flightdeck_pg_permission_grants(workspace_id,principal_type,principal_actor_id,resource_type,permission,created_by_actor_id) VALUES(${workspaceId},'actor',${agent.id},'workspace','workspace.read',${ownerId})`;
    await sql`INSERT INTO flightdeck_pg_personal_agent_settings(workspace_id,actor_id,autopilot_agents) VALUES(${workspaceId},${ownerId},${sql.json([{ agent_npub: ROTATING_AGENT_NPUB, url: 'https://agent.example.invalid' }])})`;
    const [dmScope] = await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind,created_by_actor_id) VALUES(${workspaceId},'Rotation DMs','dm',${ownerId}) RETURNING id`;
    const [dmChannel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,participant_npubs,created_by_actor_id)
      VALUES(${workspaceId},${dmScope.id},'Rotating Agent','dm',${[OWNER_NPUB, ROTATING_AGENT_NPUB, ROTATED_AGENT_NPUB, ROTATING_AGENT_NPUB]},${ownerId})
      RETURNING id
    `;
    const rotationId = 'rotation-api-success-1';
    const proof = identityRotationProof({ workspaceId, actorId: agent.id, oldNpub: ROTATING_AGENT_NPUB, newNpub: ROTATED_AGENT_NPUB, rotationId, secret: rotatedAgentSecret });
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/agents/${agent.id}/rotate-identity`;
    const body = { rotation_id: rotationId, old_npub: ROTATING_AGENT_NPUB, new_npub: ROTATED_AGENT_NPUB, proof };
    const rotated = await requestJson(path, 'POST', rotatingAgentSecret, body);
    expect(rotated.res.status).toBe(200);
    expect(rotated.json).toMatchObject({ status: 'completed', actor_id: agent.id, old_npub: ROTATING_AGENT_NPUB, new_npub: ROTATED_AGENT_NPUB, rotation_id: rotationId, migration_counts: { channel_participants: 1 }, warnings: [] });
    expect(JSON.stringify(rotated.json)).not.toContain('nsec');
    const [continuity] = await sql<any[]>`SELECT a.npub,m.role,pg.permission,s.autopilot_agents FROM flightdeck_pg_actors a JOIN flightdeck_pg_workspace_memberships m ON m.actor_id=a.id LEFT JOIN flightdeck_pg_permission_grants pg ON pg.principal_actor_id=a.id LEFT JOIN flightdeck_pg_personal_agent_settings s ON s.workspace_id=m.workspace_id AND s.actor_id=${ownerId} WHERE a.id=${agent.id} AND m.workspace_id=${workspaceId}`;
    expect(continuity).toMatchObject({ npub: ROTATED_AGENT_NPUB, role: 'agent', permission: 'workspace.read' });
    expect(continuity.autopilot_agents[0].agent_npub).toBe(ROTATED_AGENT_NPUB);
    const [rotatedDm] = await sql<{ participant_npubs: string[] }[]>`SELECT participant_npubs FROM flightdeck_pg_channels WHERE id=${dmChannel.id}`;
    expect(rotatedDm.participant_npubs).toEqual([OWNER_NPUB, ROTATED_AGENT_NPUB]);
    const [history] = await sql<any[]>`SELECT npub FROM flightdeck_pg_actor_identity_history WHERE actor_id=${agent.id}`;
    expect(history.npub).toBe(ROTATING_AGENT_NPUB);
    const oldDenied = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/me`, 'GET', rotatingAgentSecret);
    expect(oldDenied.res.status).toBe(403);
    const newAllowed = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/me`, 'GET', rotatedAgentSecret);
    expect(newAllowed.res.status).toBe(200);
    const replay = await requestJson(path, 'POST', rotatingAgentSecret, body);
    expect(replay.json.status).toBe('idempotent_replay');
  });

  test('rejects stale and wrong-new-key rotation proofs without changing the actor', async () => {
    const { workspaceId, ownerId } = await seedWorkspace('npub1workspaceidentityrotationbad');
    const staleSecret = new Uint8Array(32).fill(42);
    const staleNpub = nip19.npubEncode(getPublicKey(staleSecret));
    const [agent] = await sql<{ id: string }[]>`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${staleNpub},'agent') RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships(workspace_id,actor_id,role,created_by_actor_id) VALUES(${workspaceId},${agent.id},'agent',${ownerId})`;
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/agents/${agent.id}/rotate-identity`;
    const createdAt = Math.floor(Date.now() / 1000) - 700;
    const proof = identityRotationProof({ workspaceId, actorId: agent.id, oldNpub: staleNpub, newNpub: ROTATED_AGENT_NPUB, rotationId: 'stale-proof', secret: rotatedAgentSecret, createdAt, expiresAt: createdAt + 300 });
    const rejected = await requestJson(path, 'POST', staleSecret, { rotation_id: 'stale-proof', old_npub: staleNpub, new_npub: ROTATED_AGENT_NPUB, proof });
    expect(rejected.res.status).toBe(400);
    const wrongKeyProof = identityRotationProof({ workspaceId, actorId: agent.id, oldNpub: staleNpub, newNpub: ROTATED_AGENT_NPUB, rotationId: 'wrong-key-proof', secret: staleSecret });
    const wrongKey = await requestJson(path, 'POST', staleSecret, { rotation_id: 'wrong-key-proof', old_npub: staleNpub, new_npub: ROTATED_AGENT_NPUB, proof: wrongKeyProof });
    expect(wrongKey.res.status).toBe(400);
    const collisionSecret = new Uint8Array(32).fill(44);
    const collisionNpub = nip19.npubEncode(getPublicKey(collisionSecret));
    await sql`INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${collisionNpub},'agent')`;
    const collisionProof = identityRotationProof({ workspaceId, actorId: agent.id, oldNpub: staleNpub, newNpub: collisionNpub, rotationId: 'collision-proof', secret: collisionSecret });
    const collision = await requestJson(path, 'POST', staleSecret, { rotation_id: 'collision-proof', old_npub: staleNpub, new_npub: collisionNpub, proof: collisionProof });
    expect(collision.res.status).toBe(409);
    const [unchanged] = await sql<any[]>`SELECT npub FROM flightdeck_pg_actors WHERE id=${agent.id}`;
    expect(unchanged.npub).toBe(staleNpub);
  });

  test('personal Autopilot agents persist per actor and stale clients cannot replace them', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspacepersonalagentsettings');
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/me/autopilot-agents`;
    const initial = await requestJson(path, 'GET', ownerSecret);
    expect(initial.res.status).toBe(200);
    expect(initial.json.settings).toEqual({ autopilot_agents: [], row_version: 0, updated_at: null });

    const firstAgents = [{ agent_npub: AGENT_NPUB, url: 'https://first.example.invalid' }];
    const first = await requestJson(path, 'PUT', ownerSecret, {
      autopilot_agents: firstAgents,
      expected_row_version: 0,
    });
    expect(first.res.status).toBe(200);
    expect(first.json.settings.autopilot_agents).toEqual(firstAgents);
    expect(first.json.settings.row_version).toBe(1);

    const newerAgents = [{ agent_npub: AGENT_NPUB, url: 'https://newer.example.invalid' }];
    const newer = await requestJson(path, 'PUT', ownerSecret, {
      autopilot_agents: newerAgents,
      expected_row_version: 1,
    });
    expect(newer.res.status).toBe(200);
    expect(newer.json.settings.row_version).toBe(2);

    const staleClear = await requestJson(path, 'PUT', ownerSecret, {
      autopilot_agents: [],
      expected_row_version: 1,
    });
    expect(staleClear.res.status).toBe(409);
    expect(staleClear.json.code).toBe('stale_row_version');

    const afterConflict = await requestJson(path, 'GET', ownerSecret);
    expect(afterConflict.json.settings.autopilot_agents).toEqual(newerAgents);
    expect(afterConflict.json.settings.row_version).toBe(2);

    const explicitClear = await requestJson(path, 'PUT', ownerSecret, {
      autopilot_agents: [],
      expected_row_version: 2,
    });
    expect(explicitClear.res.status).toBe(200);
    expect(explicitClear.json.settings.autopilot_agents).toEqual([]);
    expect(explicitClear.json.settings.row_version).toBe(3);
  });

  test('admin setup route creates an idempotent default workspace descriptor without starter records', async () => {
    const path = '/api/v4/admin/flightdeck-pg/workspaces';
    const body = {
      workspace_name: 'Admin Flight Deck PG',
      workspace_description: 'Created by Tower admin UI',
      workspace_service_npub: 'npub1adminfdpgworkspace',
      creator_npub: ADMIN_NPUB,
    };
    const first = await requestJson(path, 'POST', adminSecret, body);
    const second = await requestJson(path, 'POST', adminSecret, body);

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.json.workspace_id).toBe(first.json.workspace_id);
    expect(second.json.workspace_owner_npub).toBe(ADMIN_NPUB);
    expect(second.json.actors.creator.npub).toBe(ADMIN_NPUB);
    expect(second.json.app_npub).toBe(config.flightDeck.appNpub);
    expect(second.json.descriptor_route).toBe(`/api/v4/flightdeck-pg/workspaces/${first.json.workspace_id}/descriptor`);
    expect(second.json.descriptor.identity.workspace_id).toBe(first.json.workspace_id);
    expect(second.json.descriptor.identity.workspace_service_npub).toBe(body.workspace_service_npub);
    expect(second.json.descriptor.identity.workspace_owner_npub).toBe(ADMIN_NPUB);
    expect(second.json.descriptor.identity.app_npub).toBe(config.flightDeck.appNpub);
    expect(second.json.groups.Admins).toBeDefined();
    expect(second.json.groups.Agents).toBeDefined();
    expect(second.json.groups.People).toBeDefined();
    expect(second.json.groups.Workspace).toBeDefined();
    expect(second.json.smoke.scope_id).toBeNull();
    expect(second.json.smoke.channel_id).toBeNull();
    expect(second.json.channels).toEqual({});

    const descriptorPayload = JSON.stringify(second.json.descriptor).toLowerCase();
    expect(descriptorPayload).not.toContain('bearer');
    expect(descriptorPayload).not.toContain('token');
    expect(descriptorPayload).not.toContain('password');
    expect(descriptorPayload).not.toContain('credential');
    expect(descriptorPayload).not.toContain('nsec');
    expect(descriptorPayload).not.toContain('private_key');
    expect(descriptorPayload).not.toContain('encrypted');

    const [starterRows] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_scopes s
      LEFT JOIN flightdeck_pg_channels c ON c.scope_id = s.id
      WHERE s.workspace_id = ${second.json.workspace_id}
        AND (s.name = 'Marketing' OR c.name = 'Website')
    `;
    expect(Number(starterRows.count)).toBe(0);

    const [groups] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_groups
      WHERE workspace_id = ${second.json.workspace_id}
        AND name IN ('Admins', 'Agents', 'People', 'Workspace')
    `;
    expect(Number(groups.count)).toBe(4);

    const scopesPath = `/api/v4/flightdeck-pg/workspaces/${second.json.workspace_id}/scopes`;
    const scopes = await requestJson(scopesPath, 'GET', adminSecret);
    expect(scopes.res.status).toBe(200);
    expect(scopes.json.scopes.map((scope: any) => scope.name)).toContain('DMs');
  });

  test('admin setup route creates smoke records when explicitly requested', async () => {
    const path = '/api/v4/admin/flightdeck-pg/workspaces';
    const body = {
      workspace_name: 'Admin Flight Deck PG Smoke',
      workspace_description: 'Created by Tower admin UI',
      workspace_service_npub: 'npub1adminfdpgsmokeworkspace',
      creator_npub: ADMIN_NPUB,
      smoke_scope_name: 'Marketing',
      smoke_channel_name: 'Website',
    };
    const first = await requestJson(path, 'POST', adminSecret, body);
    const second = await requestJson(path, 'POST', adminSecret, body);

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.json.workspace_id).toBe(first.json.workspace_id);
    expect(second.json.smoke.scope_id).toBeTruthy();
    expect(second.json.smoke.channel_id).toBeTruthy();

    const [smoke] = await sql<{ scope_name: string; channel_name: string }[]>`
      SELECT s.name AS scope_name, c.name AS channel_name
      FROM flightdeck_pg_scopes s
      JOIN flightdeck_pg_channels c ON c.id = ${second.json.smoke.channel_id}
      WHERE s.id = ${second.json.smoke.scope_id}
      LIMIT 1
    `;
    expect(smoke).toEqual({ scope_name: 'Marketing', channel_name: 'Website' });

    const channelsPath = `/api/v4/flightdeck-pg/workspaces/${second.json.workspace_id}/scopes/${second.json.smoke.scope_id}/channels`;
    const channels = await requestJson(channelsPath, 'GET', adminSecret);
    expect(channels.res.status).toBe(200);
    expect(channels.json.channels.map((channel: any) => channel.id)).toContain(second.json.smoke.channel_id);
  });

  test('requires NIP-98 for service metadata and returns capabilities', async () => {
    const unauthenticated = await app.request('/api/v4/flightdeck-pg/service');
    expect(unauthenticated.status).toBe(401);

    const { res, json } = await requestJson('/api/v4/flightdeck-pg/service', 'GET', ownerSecret);
    expect(res.status).toBe(200);
    expectFixtureRequiredKeys(json, 'service-metadata.json');
    expect(json.service.service_npub).toBeDefined();
    expect(json.capabilities).toContain('pg_scopes');
    expect(json.capabilities).toContain('pg_channel_grants');
  });

  test('advertises only explicitly and fully configured Git discovery', async () => {
    const previous = {
      capabilityHashKey: config.git.capabilityHashKey,
      internalServiceToken: config.git.internalServiceToken,
      audience: config.git.audience,
      gatewayOrigins: config.git.gatewayOrigins,
    };
    try {
      config.git.capabilityHashKey = 'h'.repeat(32);
      config.git.internalServiceToken = 's'.repeat(32);
      config.git.audience = 'operator-audience';
      config.git.gatewayOrigins = ['https://git.operator.example'];
      const configured = await requestJson('/api/v4/flightdeck-pg/service', 'GET', ownerSecret);
      expect(configured.res.status).toBe(200);
      expect(configured.json.git).toEqual({
        gateway_origins: ['https://git.operator.example'],
        audience: 'operator-audience',
      });

      config.git.gatewayOrigins = ['http://127.0.0.1:3180'];
      const insecure = await requestJson('/api/v4/flightdeck-pg/service', 'GET', ownerSecret);
      expect(insecure.json.git).toBeUndefined();

      config.git.gatewayOrigins = [];
      const absent = await requestJson('/api/v4/flightdeck-pg/service', 'GET', ownerSecret);
      expect(absent.json.git).toBeUndefined();
    } finally {
      Object.assign(config.git, previous);
    }
  });

  test('serves notification settings as a backward-compatible config alias', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgnotificationsettings');
    const configPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/config`;
    const settingsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/settings`;

    const configResponse = await requestJson(configPath, 'GET', ownerSecret);
    expect(configResponse.res.status).toBe(200);

    const settingsResponse = await requestJson(settingsPath, 'GET', ownerSecret);
    expect(settingsResponse.res.status).toBe(200);
    expect(settingsResponse.json).toEqual(configResponse.json);
    expect(settingsResponse.json.subscription_scope).toBe('browser_install');
    expect(settingsResponse.json.preferences_scope).toBe('workspace_actor');
  });

  test('registers push subscriptions and records notification delivery evidence from message outbox', async () => {
    const { workspaceId, ownerId, groupMemberId, groupId } = await seedWorkspace('npub1workspaceflightdeckpgnotifications');
    const [parentGroup] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspaceId}, 'All Staff', 'custom', ${ownerId})
      RETURNING id
    `;
    await sql`
      INSERT INTO flightdeck_pg_group_edges (workspace_id, parent_group_id, child_group_id, created_by_actor_id)
      VALUES (${workspaceId}, ${parentGroup.id}, ${groupId}, ${ownerId})
    `;

    const preferencesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/preferences`;
    const preferences = await requestJson(preferencesPath, 'GET', groupMemberSecret);
    expect(preferences.res.status).toBe(200);
    expect(preferences.json.preferences.chat_threads_enabled).toBe(true);
    expect(preferences.json.preferences.mentions_enabled).toBe(true);

    const subscriptionPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/subscriptions`;
    const subscription = await requestJson(subscriptionPath, 'POST', groupMemberSecret, {
      endpoint: 'https://push.example.invalid/subscription/group-member',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      device_label: 'Test Browser',
      platform: 'test',
      app_version: 'test-suite',
    });
    expect(subscription.res.status).toBe(201);
    expect(subscription.json.subscription.status).toBe('active');
    expect(subscription.json.subscriptions).toHaveLength(1);

    const scopeCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, {
      name: 'Notifications',
      kind: 'project',
    });
    expect(scopeCreate.res.status).toBe(201);
    const channelCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeCreate.json.scope.id}/channels`, 'POST', ownerSecret, {
      name: 'General',
      kind: 'channel',
      grants: [{ principal_type: 'group', principal_id: parentGroup.id, access_level: 'view' }],
    });
    expect(channelCreate.res.status).toBe(201);
    const channelId = channelCreate.json.channel.id as string;
    const body = `Hello @[Group Member](mention:person:${groupMemberId})`;
    const messageCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/messages`, 'POST', ownerSecret, {
      body,
      create_thread: true,
      message_signature: messageSignature({ body, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(messageCreate.res.status).toBe(201);
    expect(messageCreate.json.outbox.id).toBeTruthy();

    const deliveries = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/deliveries`, 'GET', groupMemberSecret);
    expect(deliveries.res.status).toBe(200);
    expect(deliveries.json.deliveries.map((delivery: any) => delivery.category)).toEqual(expect.arrayContaining(['chat_thread', 'mention']));
    expect(deliveries.json.deliveries.map((delivery: any) => delivery.body)).toEqual(expect.arrayContaining(['Thread Update: Hello', 'Mentioned in Hello']));
    expect(deliveries.json.deliveries.every((delivery: any) => delivery.payload?.target?.thread_title === 'Hello')).toBe(true);
    expect(deliveries.json.deliveries.every((delivery: any) => delivery.title === 'Flight Deck: Flight Deck PG API Test')).toBe(true);
    expect(deliveries.json.deliveries.every((delivery: any) => ['sent', 'skipped', 'failed'].includes(delivery.decision))).toBe(true);
    expect(deliveries.json.deliveries.every((delivery: any) => delivery.decision !== 'failed' || Boolean(delivery.failure_reason))).toBe(true);

    const evaluateAgain = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/evaluate`, 'POST', ownerSecret, {
      outbox_event_id: messageCreate.json.outbox.id,
    });
    expect(evaluateAgain.res.status).toBe(200);
    const deliveriesAfterReplay = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/deliveries`, 'GET', groupMemberSecret);
    expect(deliveriesAfterReplay.json.deliveries).toHaveLength(deliveries.json.deliveries.length);
  });

  test('dedupes repeated task assignments and skipped notification replay without subscriptions', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgassignmentdedupe');
    const inviteeCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, {
      member_npub: INVITEE_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'Assignment Dedupe Member',
    });
    expect(inviteeCreate.res.status).toBe(201);
    const inviteeId = inviteeCreate.json.actor.actor_id as string;

    const scopeCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, {
      name: 'Assignment Dedupe',
      kind: 'project',
    });
    expect(scopeCreate.res.status).toBe(201);
    const channelCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeCreate.json.scope.id}/channels`, 'POST', ownerSecret, {
      name: 'Notifications',
      kind: 'channel',
      grants: [{ principal_type: 'actor', principal_id: inviteeId, access_level: 'view' }],
    });
    expect(channelCreate.res.status).toBe(201);
    const channelId = channelCreate.json.channel.id as string;

    const taskCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/tasks`, 'POST', ownerSecret, {
      title: 'Idempotent Assignment',
      state: 'new',
      priority: 'normal',
    });
    expect(taskCreate.res.status).toBe(201);
    const taskId = taskCreate.json.task.id as string;

    const assignmentsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/assignments`;
    const firstAssignment = await requestJson(assignmentsPath, 'POST', ownerSecret, { actor_id: inviteeId });
    expect(firstAssignment.res.status).toBe(201);
    expect(firstAssignment.json.changed).toBe(true);
    expect(firstAssignment.json.outbox.id).toBeTruthy();

    const secondAssignment = await requestJson(assignmentsPath, 'POST', ownerSecret, { actor_id: inviteeId });
    expect(secondAssignment.res.status).toBe(200);
    expect(secondAssignment.json.changed).toBe(false);
    expect(secondAssignment.json.audit).toBeNull();
    expect(secondAssignment.json.outbox).toBeNull();

    const [assignedOutboxCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_outbox_events
      WHERE workspace_id = ${workspaceId}
        AND event_type = 'flightdeck_pg.task_assignment.assigned'
        AND payload->>'task_id' = ${taskId}
    `;
    expect(Number(assignedOutboxCount.count)).toBe(1);

    const deliveriesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/deliveries`;
    const deliveries = await requestJson(deliveriesPath, 'GET', inviteeSecret);
    expect(deliveries.res.status).toBe(200);
    const assignmentDeliveries = deliveries.json.deliveries.filter((delivery: any) => delivery.category === 'task_assignment');
    expect(assignmentDeliveries).toHaveLength(1);
    expect(assignmentDeliveries[0].decision).toBe('skipped');
    expect(assignmentDeliveries[0].failure_reason).toBe('no_active_subscription');
    expect(assignmentDeliveries[0].subscription_id).toBeNull();

    const replayNoSubscription = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/evaluate`, 'POST', ownerSecret, {
      outbox_event_id: firstAssignment.json.outbox.id,
    });
    expect(replayNoSubscription.res.status).toBe(200);
    const deliveriesAfterReplay = await requestJson(deliveriesPath, 'GET', inviteeSecret);
    expect(deliveriesAfterReplay.json.deliveries.filter((delivery: any) => delivery.failure_reason === 'no_active_subscription')).toHaveLength(1);

    const preferences = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/preferences`, 'PATCH', inviteeSecret, {
      task_assignments_enabled: false,
    });
    expect(preferences.res.status).toBe(200);
    expect(preferences.json.preferences.task_assignments_enabled).toBe(false);

    const secondTask = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/tasks`, 'POST', ownerSecret, {
      title: 'Preference Disabled Assignment',
      state: 'new',
      priority: 'normal',
    });
    expect(secondTask.res.status).toBe(201);
    const disabledAssignment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${secondTask.json.task.id}/assignments`, 'POST', ownerSecret, {
      actor_id: inviteeId,
    });
    expect(disabledAssignment.res.status).toBe(201);
    expect(disabledAssignment.json.outbox.id).toBeTruthy();

    const replayPreferenceDisabled = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/evaluate`, 'POST', ownerSecret, {
      outbox_event_id: disabledAssignment.json.outbox.id,
    });
    expect(replayPreferenceDisabled.res.status).toBe(200);
    const deliveriesAfterPreferenceReplay = await requestJson(deliveriesPath, 'GET', inviteeSecret);
    expect(deliveriesAfterPreferenceReplay.json.deliveries.filter((delivery: any) => delivery.failure_reason === 'preference_disabled')).toHaveLength(1);
  });

  test('evaluates DM, comment mention, task assignment, and device revoke notifications', async () => {
    const { workspaceId, ownerId, groupMemberId, groupId } = await seedWorkspace('npub1workspaceflightdeckpgmorenotifications');
    const memberCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, {
      member_npub: MEMBER_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'Member',
    });
    expect(memberCreate.res.status).toBe(201);
    const memberId = memberCreate.json.actor.actor_id as string;

    const subscriptionPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/subscriptions`;
    const groupSubscription = await requestJson(subscriptionPath, 'POST', groupMemberSecret, {
      endpoint: 'https://push.example.invalid/subscription/group-member-more',
      keys: { p256dh: 'p256dh-key-more', auth: 'auth-key-more' },
      device_label: 'Group Member Browser',
    });
    expect(groupSubscription.res.status).toBe(201);
    const memberSubscription = await requestJson(subscriptionPath, 'POST', memberSecret, {
      endpoint: 'https://push.example.invalid/subscription/member-dm',
      keys: { p256dh: 'p256dh-key-member', auth: 'auth-key-member' },
      device_label: 'Member Browser',
    });
    expect(memberSubscription.res.status).toBe(201);

    const scopeCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, {
      name: 'Notification Surface',
      kind: 'project',
    });
    expect(scopeCreate.res.status).toBe(201);
    const scopeId = scopeCreate.json.scope.id as string;
    const channelCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`, 'POST', ownerSecret, {
      name: 'Delivery',
      kind: 'channel',
      grants: [{ principal_type: 'group', principal_id: groupId, access_level: 'view' }],
    });
    expect(channelCreate.res.status).toBe(201);
    const channelId = channelCreate.json.channel.id as string;

    const dmCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`, 'POST', ownerSecret, {
      name: 'Owner and Member DM',
      kind: 'dm',
      participant_npubs: [OWNER_NPUB, MEMBER_NPUB],
    });
    expect(dmCreate.res.status).toBe(201);
    const dmChannelId = dmCreate.json.channel.id as string;
    const dmBody = 'Private delivery check';
    const dmMessage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${dmChannelId}/messages`, 'POST', ownerSecret, {
      body: dmBody,
      message_signature: messageSignature({ body: dmBody, secret: ownerSecret, workspaceId, channelId: dmChannelId }),
    });
    expect(dmMessage.res.status).toBe(201);

    const [workspaceOwner] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${workspaceId}
      LIMIT 1
    `;
    const [docStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'notification-plan.md',
        'text/markdown',
        128,
        'v4/flightdeck-pg/api/notification-plan.md'
      )
      RETURNING id
    `;
    const docCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/docs`, 'POST', ownerSecret, {
      title: 'Notification Plan',
      storage_object_id: docStorageObject.id,
    });
    expect(docCreate.res.status).toBe(201);
    const docComment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docCreate.json.doc.id}/comments`, 'POST', ownerSecret, {
      body: `Please review @[Group Member](mention:person:${groupMemberId})`,
    });
    expect(docComment.res.status).toBe(201);

    const taskCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/tasks`, 'POST', ownerSecret, {
      title: 'Notification Task',
      state: 'new',
      priority: 'normal',
    });
    expect(taskCreate.res.status).toBe(201);
    const taskId = taskCreate.json.task.id as string;
    const taskComment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/comments`, 'POST', ownerSecret, {
      body: `Can you pick this up @[Group Member](mention:person:${GROUP_MEMBER_NPUB})`,
    });
    expect(taskComment.res.status).toBe(201);
    const assignment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/assignments`, 'POST', ownerSecret, {
      actor_id: groupMemberId,
    });
    expect(assignment.res.status).toBe(201);

    const memberDeliveries = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/deliveries`, 'GET', memberSecret);
    expect(memberDeliveries.res.status).toBe(200);
    expect(memberDeliveries.json.deliveries.map((delivery: any) => delivery.category)).toContain('dm');
    expect(memberDeliveries.json.deliveries.map((delivery: any) => delivery.body)).toContain('New DM: Owner and Member DM');

    const groupDeliveries = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/deliveries`, 'GET', groupMemberSecret);
    expect(groupDeliveries.res.status).toBe(200);
    expect(groupDeliveries.json.deliveries.map((delivery: any) => delivery.category)).toEqual(expect.arrayContaining(['comment_tag', 'task_assignment']));
    expect(groupDeliveries.json.deliveries.map((delivery: any) => delivery.body)).toEqual(expect.arrayContaining([
      'New Comment in Notification Plan',
      'New Comment in Notification Task',
      'Task Assigned: Notification Surface | Delivery',
    ]));

    const revoke = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/notifications/subscriptions/${groupSubscription.json.subscription.id}`,
      'DELETE',
      groupMemberSecret,
    );
    expect(revoke.res.status).toBe(200);
    expect(revoke.json.subscription.status).toBe('revoked');
    const groupDevices = await requestJson(subscriptionPath, 'GET', groupMemberSecret);
    expect(groupDevices.json.subscriptions.find((device: any) => device.id === groupSubscription.json.subscription.id).status).toBe('revoked');

    expect(memberId).toBeTruthy();
    expect(ownerId).toBeTruthy();
    expect(memberSubscription.json.subscription.status).toBe('active');
  });

  test('renames scopes with scope.manage and rejects blank names', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgrename');
    const scopesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`;
    const created = await requestJson(scopesPath, 'POST', ownerSecret, {
      name: 'Original scope',
      description: 'Original description',
      kind: 'project',
    });
    expect(created.res.status).toBe(201);
    const scopePath = `${scopesPath}/${created.json.scope.id}`;

    const renamed = await requestJson(scopePath, 'PATCH', ownerSecret, {
      name: 'Renamed scope',
      description: 'Updated description',
    });
    expect(renamed.res.status).toBe(200);
    expect(renamed.json.scope.name).toBe('Renamed scope');
    expect(renamed.json.scope.description).toBe('Updated description');
    expect(renamed.json.audit.operation).toBe('scope.update');

    const listed = await requestJson(scopesPath, 'GET', ownerSecret);
    expect(listed.json.scopes.find((scope: any) => scope.id === created.json.scope.id)?.name).toBe('Renamed scope');
    expect(listed.json.scopes.find((scope: any) => scope.id === created.json.scope.id)?.can_manage).toBe(true);

    const blank = await requestJson(scopePath, 'PATCH', ownerSecret, { name: '   ' });
    expect(blank.res.status).toBe(400);
  });

  test('soft deletes PG chat messages and threads', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgdelete');
    const scopesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`;
    const scopeCreate = await requestJson(scopesPath, 'POST', ownerSecret, {
      name: 'Chat Delete',
      kind: 'project',
    });
    expect(scopeCreate.res.status).toBe(201);
    const scopeId = scopeCreate.json.scope.id as string;

    const channelsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`;
    const channelCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'General',
      kind: 'channel',
    });
    expect(channelCreate.res.status).toBe(201);
    const channelId = channelCreate.json.channel.id as string;

    const messagesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/messages`;
    const threadsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads`;
    const rootBody = 'Thread that will survive one reply delete.';
    const rootCreate = await requestJson(messagesPath, 'POST', ownerSecret, {
      body: rootBody,
      create_thread: true,
      thread_title: 'Thread delete API',
      message_signature: messageSignature({ body: rootBody, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(rootCreate.res.status).toBe(201);
    const threadId = rootCreate.json.thread.id as string;
    const rootMessageId = rootCreate.json.message.id as string;

    const replyBody = 'Reply that will be deleted alone.';
    const replyCreate = await requestJson(messagesPath, 'POST', ownerSecret, {
      body: replyBody,
      thread_id: threadId,
      message_signature: messageSignature({ body: replyBody, secret: ownerSecret, workspaceId, channelId, threadId }),
    });
    expect(replyCreate.res.status).toBe(201);
    const replyMessageId = replyCreate.json.message.id as string;

    const messageDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/messages/${replyMessageId}`, 'DELETE', ownerSecret);
    expect(messageDelete.res.status).toBe(200);
    expect(messageDelete.json.message.id).toBe(replyMessageId);
    expect(messageDelete.json.message.record_state).toBe('deleted');
    expect(messageDelete.json.audit.operation).toBe('message.delete');
    expect(messageDelete.json.outbox.id).toBeTruthy();

    const afterMessageDelete = await requestJson(`${messagesPath}?thread_id=${threadId}`, 'GET', ownerSecret);
    expect(afterMessageDelete.res.status).toBe(200);
    expect(afterMessageDelete.json.messages.map((message: any) => message.id)).toContain(rootMessageId);
    expect(afterMessageDelete.json.messages.map((message: any) => message.id)).not.toContain(replyMessageId);

    const threadDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/threads/${threadId}`, 'DELETE', ownerSecret);
    expect(threadDelete.res.status).toBe(200);
    expect(threadDelete.json.thread.id).toBe(threadId);
    expect(threadDelete.json.thread.record_state).toBe('deleted');
    expect(threadDelete.json.audit.operation).toBe('thread.delete');
    expect(threadDelete.json.outbox.id).toBeTruthy();

    const afterThreadDeleteMessages = await requestJson(messagesPath, 'GET', ownerSecret);
    expect(afterThreadDeleteMessages.res.status).toBe(200);
    expect(afterThreadDeleteMessages.json.messages.map((message: any) => message.id)).not.toContain(rootMessageId);

    const afterThreadDeleteThreads = await requestJson(threadsPath, 'GET', ownerSecret);
    expect(afterThreadDeleteThreads.res.status).toBe(200);
    expect(afterThreadDeleteThreads.json.threads.map((thread: any) => thread.id)).not.toContain(threadId);
  });

  test('creates members, scopes, channels, actor grants, group grants, and hides sibling channels', async () => {
    const { workspaceId, ownerId, groupMemberId, groupId } = await seedWorkspace();

    const workspacesPath = `/api/v4/flightdeck-pg/workspaces?app_npub=${encodeURIComponent(APP_NPUB)}`;
    const workspacesList = await requestJson(workspacesPath, 'GET', ownerSecret);
    expect(workspacesList.res.status).toBe(200);
    expect(workspacesList.json.workspaces.map((workspace: any) => workspace.identity.workspace_id)).toContain(workspaceId);
    expect(workspacesList.json.workspaces[0].links.descriptor).toContain('/descriptor');

    const descriptorPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/descriptor`;
    const descriptor = await requestJson(descriptorPath, 'GET', ownerSecret);
    expect(descriptor.res.status).toBe(200);
    expectFixtureRequiredKeys(descriptor.json, 'workspace-descriptor.json');
    expect(descriptor.json.type).toBe('wingman_workspace_locator');
    expect(descriptor.json.identity.tower_service_npub).toBe('npub1towerflightdeckpgapi');
    expect(descriptor.json.identity.workspace_service_npub).toBe('npub1workspaceflightdeckpgapi');
    expect(descriptor.json.identity.workspace_owner_npub).toBe(OWNER_NPUB);
    expect(descriptor.json.identity.workspace_id).toBe(workspaceId);
    expect(descriptor.json.identity.app_npub).toBe(APP_NPUB);
    expect(descriptor.json.tower_base_url).toBe('http://localhost');
    expect(descriptor.json.capabilities).toContain('pg_channels');
    const descriptorPayload = JSON.stringify(descriptor.json).toLowerCase();
    expect(descriptorPayload).not.toContain('bearer');
    expect(descriptorPayload).not.toContain('token');
    expect(descriptorPayload).not.toContain('password');
    expect(descriptorPayload).not.toContain('credential');
    expect(descriptorPayload).not.toContain('nsec');

    const profilePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;
    const unauthorizedProfileUpdate = await requestJson(profilePath, 'PATCH', groupMemberSecret, {
      name: 'Denied Rename',
      description: 'Denied update',
    });
    expect(unauthorizedProfileUpdate.res.status).toBe(403);
    expect(unauthorizedProfileUpdate.json.required_permission).toBe('workspace.manage');

    const profileUpdate = await requestJson(profilePath, 'PATCH', ownerSecret, {
      name: 'Testing Space',
      description: 'Workspace profile updated by Flight Deck',
      slug: 'testing-space',
      avatar_url: null,
      metadata: {
        wingman_harness_url: 'https://agent.example.invalid',
        wingman_harness_agent_npub: 'npub1testagent',
      },
    });
    expect(profileUpdate.res.status).toBe(200);
    expect(profileUpdate.json.name).toBe('Testing Space');
    expect(profileUpdate.json.description).toBe('Workspace profile updated by Flight Deck');
    expect(profileUpdate.json.slug).toBe('testing-space');
    expect(profileUpdate.json.metadata.wingman_harness_url).toBe('https://agent.example.invalid');
    expect(profileUpdate.json.metadata.wingman_harness_agent_npub).toBe('npub1testagent');
    expect(profileUpdate.json.workspace.label).toBe('Testing Space');
    expect(profileUpdate.json.workspace.slug).toBe('testing-space');
    expect(profileUpdate.json.workspace.metadata.wingman_harness_url).toBe('https://agent.example.invalid');

    const renamedDescriptor = await requestJson(descriptorPath, 'GET', ownerSecret);
    expect(renamedDescriptor.json.label).toBe('Testing Space');
    expect(renamedDescriptor.json.slug).toBe('testing-space');
    expect(renamedDescriptor.json.description).toBe('Workspace profile updated by Flight Deck');
    expect(renamedDescriptor.json.metadata.wingman_harness_agent_npub).toBe('npub1testagent');

    const renamedWorkspacesList = await requestJson(workspacesPath, 'GET', ownerSecret);
    const renamedWorkspace = renamedWorkspacesList.json.workspaces.find((workspace: any) => workspace.identity.workspace_id === workspaceId);
    expect(renamedWorkspace.label).toBe('Testing Space');
    expect(renamedWorkspace.slug).toBe('testing-space');
    expect(renamedWorkspace.metadata.wingman_harness_url).toBe('https://agent.example.invalid');

    const mePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/me`;
    const me = await requestJson(mePath, 'GET', ownerSecret);
    expect(me.res.status).toBe(200);
    expectFixtureRequiredKeys(me.json, 'me.json');
    expect(me.json.actor.npub).toBe(OWNER_NPUB);
    expect(me.json.membership.role).toBe('owner');

    const duplicateGroupPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/groups`;
    const duplicateGroup = await requestJson(duplicateGroupPath, 'POST', ownerSecret, {
      name: 'External Viewers',
      kind: 'custom',
    });
    expect(duplicateGroup.res.status).toBe(409);
    expect(duplicateGroup.json.code).toBe('duplicate_group');

    const memberPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`;
    const memberCreate = await requestJson(memberPath, 'POST', ownerSecret, {
      member_npub: MEMBER_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'Channel Member',
    });
    expect(memberCreate.res.status).toBe(201);
    expect(memberCreate.json.actor.npub).toBe(MEMBER_NPUB);
    await sql`
      INSERT INTO user_profiles (user_npub, display_name)
      VALUES (${MEMBER_NPUB}, NULL)
      ON CONFLICT (user_npub) DO UPDATE SET display_name = NULL
    `;
    const selfProfileUpdate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/me`, 'PATCH', memberSecret, {
      display_name: 'Channel Member Self',
    });
    expect(selfProfileUpdate.res.status).toBe(200);
    expect(selfProfileUpdate.json.actor).toMatchObject({ actor_id: memberCreate.json.actor.actor_id, npub: MEMBER_NPUB, display_name: 'Channel Member Self' });
    expect(selfProfileUpdate.json.outbox.row_version).toBeNumber();
    const [mirroredSelfProfile] = await sql<{ display_name: string | null }[]>`
      SELECT display_name FROM user_profiles WHERE user_npub = ${MEMBER_NPUB}
    `;
    expect(mirroredSelfProfile.display_name).toBe('Channel Member Self');

    const unauthorizedMemberNameUpdate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members/${ownerId}/profile`, 'PATCH', memberSecret, {
      display_name: 'Not Operator',
    });
    expect(unauthorizedMemberNameUpdate.res.status).toBe(403);
    const managedProfileUpdate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members/${memberCreate.json.actor.actor_id}/profile`, 'PATCH', ownerSecret, {
      display_name: 'Channel Member Managed',
    });
    expect(managedProfileUpdate.res.status).toBe(200);
    expect(managedProfileUpdate.json.actor.display_name).toBe('Channel Member Managed');
    const memberDirectoryAfterProfile = await requestJson(memberPath, 'GET', ownerSecret);
    expect(memberDirectoryAfterProfile.json.members.find((entry: any) => entry.actor.npub === MEMBER_NPUB)?.actor.display_name).toBe('Channel Member Managed');
    const profileEvents = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events`, 'GET', ownerSecret);
    const profileEvent = profileEvents.json.events.find((event: any) => event.entity_id === memberCreate.json.actor.actor_id && event.event_type === 'actor.profile.updated' && event.payload?.display_name === 'Channel Member Managed');
    expect(profileEvent).toMatchObject({ entity_type: 'actor', operation: 'updated', payload: { actor_npub: MEMBER_NPUB, display_name: 'Channel Member Managed' } });

    await sql`UPDATE flightdeck_pg_actors SET display_name = 'Flight Deck PG Collaborator' WHERE id = ${memberCreate.json.actor.actor_id}`;
    const refreshedMember = await requestJson(memberPath, 'POST', ownerSecret, {
      member_npub: MEMBER_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'Channel Member Refreshed',
    });
    expect(refreshedMember.res.status).toBe(201);
    expect(refreshedMember.json.actor.display_name).toBe('Channel Member Refreshed');
    const [mirroredRefresh] = await sql<{ display_name: string | null }[]>`
      SELECT display_name FROM user_profiles WHERE user_npub = ${MEMBER_NPUB}
    `;
    expect(mirroredRefresh.display_name).toBe('Channel Member Refreshed');
    const [memberChannelGrant] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_permission_grants pg
      JOIN flightdeck_pg_actors a ON a.id = pg.principal_actor_id
      WHERE pg.workspace_id = ${workspaceId}
        AND a.npub = ${MEMBER_NPUB}
        AND pg.resource_type = 'channel'
        AND pg.revoked_at IS NULL
    `;
    expect(Number(memberChannelGrant.count)).toBe(0);

    const invitesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/invites`;
    const unauthorizedInvite = await requestJson(invitesPath, 'POST', groupMemberSecret, {
      invitee_npub: INVITEE_NPUB,
      role: 'member',
      kind: 'human',
    });
    expect(unauthorizedInvite.res.status).toBe(403);
    expect(unauthorizedInvite.json.required_permission).toBe('workspace.invite');

    const inviteCreate = await requestJson(invitesPath, 'POST', ownerSecret, {
      invitee_npub: INVITEE_NPUB,
      role: 'guest',
      kind: 'human',
      display_name: 'Invited Guest',
    });
    expect(inviteCreate.res.status).toBe(201);
    expect(inviteCreate.json.invite.status).toBe('membership_recorded');
    expect(inviteCreate.json.actor.npub).toBe(INVITEE_NPUB);
    expect(inviteCreate.json.membership.role).toBe('guest');
    const [inviteAudit] = await sql<{ action: string; status: string }[]>`
      SELECT action, metadata->>'status' AS status
      FROM flightdeck_pg_audit_events
      WHERE workspace_id = ${workspaceId}
        AND action = 'workspace_invite.create'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(inviteAudit).toEqual({ action: 'workspace_invite.create', status: 'membership_recorded' });

    await sql`
      DELETE FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceId}
        AND actor_id = ${inviteCreate.json.actor.actor_id}
    `;
    const removedMemberMe = await requestJson(mePath, 'GET', inviteeSecret);
    expect(removedMemberMe.res.status).toBe(403);
    expect(removedMemberMe.json.code).toBe('workspace_membership_required');

    const scopesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`;
    const scopeCreate = await requestJson(scopesPath, 'POST', ownerSecret, {
      name: 'Autopilot',
      description: 'Runtime work',
      kind: 'project',
    });
    expect(scopeCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(scopeCreate.json, 'scopes-create.json');
    const scopeId = scopeCreate.json.scope.id as string;

    const scopesList = await requestJson(scopesPath, 'GET', ownerSecret);
    expect(scopesList.res.status).toBe(200);
    expectFixtureRequiredKeys(scopesList.json, 'scopes-list.json');
    expect(scopesList.json.scopes.map((scope: any) => scope.id)).toContain(scopeId);

    const channelsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`;
    const channelCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Bugs',
      description: 'Bug reports',
      kind: 'channel',
      metadata: { basePrompt: 'Bug triage context' },
    });
    expect(channelCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(channelCreate.json, 'channels-create.json');
    expect(channelCreate.json.channel.metadata.basePrompt).toBe('Bug triage context');
    expect(channelCreate.json.channel.metadata.agent_chat).toEqual({ enabled: true, context_prompt: 'Bug triage context', activation: 'mention_then_continue' });
    const channelId = channelCreate.json.channel.id as string;

    const channelUpdate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}`, 'PATCH', ownerSecret, {
      metadata: { basePrompt: 'Updated bug triage context' },
    });
    expect(channelUpdate.res.status).toBe(200);
    expect(channelUpdate.json.channel.metadata.basePrompt).toBeUndefined();
    expect(channelUpdate.json.channel.metadata.agent_chat.context_prompt).toBe('Updated bug triage context');
    expect(channelUpdate.json.audit.operation).toBe('channel.update');

    const siblingCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Sibling',
      kind: 'channel',
    });
    expect(siblingCreate.res.status).toBe(201);
    const siblingChannelId = siblingCreate.json.channel.id as string;

    const ownerChannels = await requestJson(channelsPath, 'GET', ownerSecret);
    expect(ownerChannels.res.status).toBe(200);
    expectFixtureRequiredKeys(ownerChannels.json, 'channels-list.json');
    expect(ownerChannels.json.channels.map((channel: any) => channel.id)).toEqual(
      expect.arrayContaining([channelId, siblingChannelId]),
    );
    expect(ownerChannels.json.channels.map((channel: any) => channel.position)).toEqual([1, 2]);

    await sql`
      UPDATE flightdeck_pg_channels
      SET position = NULL
      WHERE workspace_id = ${workspaceId}
        AND scope_id = ${scopeId}
    `;
    const legacyFallbackChannels = await requestJson(channelsPath, 'GET', ownerSecret);
    expect(legacyFallbackChannels.json.channels.map((channel: any) => channel.id)).toEqual([channelId, siblingChannelId]);
    expect(legacyFallbackChannels.json.channels.map((channel: any) => channel.position)).toEqual([null, null]);

    const thirdCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Third',
      kind: 'channel',
    });
    expect(thirdCreate.res.status).toBe(201);
    const thirdChannelId = thirdCreate.json.channel.id as string;
    expect(thirdCreate.json.channel.position).toBe(3);

    const moveUp = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${thirdChannelId}/reorder`, 'POST', ownerSecret, {
      position: 1,
    });
    expect(moveUp.res.status).toBe(200);
    expect(moveUp.json).toMatchObject({ previous_position: 3, position: 1, changed: true, channel_count: 3 });
    const afterMoveUp = await requestJson(channelsPath, 'GET', ownerSecret);
    expect(afterMoveUp.json.channels.map((channel: any) => channel.id)).toEqual([thirdChannelId, channelId, siblingChannelId]);
    expect(afterMoveUp.json.channels.map((channel: any) => channel.position)).toEqual([1, 2, 3]);

    const noOpMove = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${thirdChannelId}/reorder`, 'POST', ownerSecret, {
      position: 1,
    });
    expect(noOpMove.res.status).toBe(200);
    expect(noOpMove.json).toMatchObject({ previous_position: 1, position: 1, changed: false });
    expect(noOpMove.json.outbox).toEqual([]);

    const moveDown = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${thirdChannelId}/reorder`, 'POST', ownerSecret, {
      position: 3,
    });
    expect(moveDown.res.status).toBe(200);
    const afterMoveDown = await requestJson(channelsPath, 'GET', ownerSecret);
    expect(afterMoveDown.json.channels.map((channel: any) => channel.id)).toEqual([channelId, siblingChannelId, thirdChannelId]);
    expect(afterMoveDown.json.channels.map((channel: any) => channel.position)).toEqual([1, 2, 3]);

    const clampedMove = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/reorder`, 'POST', ownerSecret, {
      position: 99,
    });
    expect(clampedMove.res.status).toBe(200);
    expect(clampedMove.json).toMatchObject({ previous_position: 1, position: 3, requested_position: 99, changed: true });
    const afterClamp = await requestJson(channelsPath, 'GET', ownerSecret);
    expect(afterClamp.json.channels.map((channel: any) => channel.id)).toEqual([siblingChannelId, thirdChannelId, channelId]);
    expect(afterClamp.json.channels.map((channel: any) => channel.position)).toEqual([1, 2, 3]);

    const invalidMove = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/reorder`, 'POST', ownerSecret, {
      position: 0,
    });
    expect(invalidMove.res.status).toBe(400);
    expect(invalidMove.json.details.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'position', code: 'invalid' }),
    ]));

    const isolatedScope = await requestJson(scopesPath, 'POST', ownerSecret, {
      name: 'Isolated ordering',
      kind: 'project',
    });
    expect(isolatedScope.res.status).toBe(201);
    const isolatedChannelsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${isolatedScope.json.scope.id}/channels`;
    const isolatedChannel = await requestJson(isolatedChannelsPath, 'POST', ownerSecret, { name: 'Only', kind: 'channel' });
    expect(isolatedChannel.res.status).toBe(201);
    expect(isolatedChannel.json.channel.position).toBe(1);
    const isolatedChannels = await requestJson(isolatedChannelsPath, 'GET', ownerSecret);
    expect(isolatedChannels.json.channels.map((channel: any) => [channel.id, channel.position])).toEqual([
      [isolatedChannel.json.channel.id, 1],
    ]);

    const grantsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/grants`;
    const actorGrant = await requestJson(grantsPath, 'POST', ownerSecret, {
      principal_type: 'person',
      principal_id: memberCreate.json.actor.actor_id,
      access_level: 'view',
    });
    expect(actorGrant.res.status).toBe(201);
    expectFixtureRequiredKeys(actorGrant.json, 'channel-grants-create.json');
    expect(actorGrant.json.grant.principal_type).toBe('person');
    expect(actorGrant.json.grant.access_level).toBe('view');
    expect(actorGrant.json.grant.principal.npub).toBe(MEMBER_NPUB);
    expect(actorGrant.json.grant.permissions).toEqual(expect.arrayContaining(['channel.read', 'task.read', 'doc.read', 'file.read', 'audio_note.read']));
    const unauthorizedReorder = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/reorder`, 'POST', memberSecret, {
      position: 1,
    });
    expect(unauthorizedReorder.res.status).toBe(403);
    expect(unauthorizedReorder.json.required_permission).toBe('channel.manage');

    const groupGrant = await requestJson(grantsPath, 'POST', ownerSecret, {
      principal_type: 'group',
      principal_id: groupId,
      access_level: 'contribute',
    });
    expect(groupGrant.res.status).toBe(201);
    expect(groupGrant.json.grant.principal_type).toBe('group');
    expect(groupGrant.json.grant.principal.name).toBe('External Viewers');
    expect(groupGrant.json.grant.access_level).toBe('contribute');
    expect(groupGrant.json.grant.permissions).toEqual(expect.arrayContaining(['channel.read', 'channel.write', 'task.create']));

    const agentMember = await requestJson(memberPath, 'POST', ownerSecret, {
      member_npub: AGENT_NPUB,
      role: 'member',
      kind: 'agent',
      display_name: 'Agent',
    });
    expect(agentMember.res.status).toBe(201);
    const inaccessibleAgent = await requestJson(memberPath, 'POST', ownerSecret, {
      member_npub: INACCESSIBLE_AGENT_NPUB,
      role: 'member',
      kind: 'agent',
      display_name: 'No Access Agent',
    });
    expect(inaccessibleAgent.res.status).toBe(201);
    const agentGrant = await requestJson(grantsPath, 'POST', ownerSecret, {
      principal_type: 'person',
      principal_id: agentMember.json.actor.actor_id,
      access_level: 'contribute',
    });
    expect(agentGrant.res.status).toBe(201);


    const enableAgentChat = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}`, 'PATCH', ownerSecret, {
      metadata: { unrelated: 'preserved', agent_chat: { enabled: true, context_prompt: 'Help with Tower.', activation: 'mention_then_continue' } },
    });
    expect(enableAgentChat.res.status).toBe(200);
    expect(enableAgentChat.json.channel.metadata.agent_chat).toEqual({ enabled: true, context_prompt: 'Help with Tower.', activation: 'mention_then_continue' });
    expect(enableAgentChat.json.channel.metadata.unrelated).toBe('preserved');

    const legacyDisableAgentChat = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}`, 'PATCH', ownerSecret, {
      metadata: { agent_chat: { enabled: false, context_prompt: 'Legacy false remains context-only.', activation: 'mention_then_continue' } },
    });
    expect(legacyDisableAgentChat.res.status).toBe(200);
    expect(legacyDisableAgentChat.json.channel.metadata.agent_chat).toEqual({
      enabled: true,
      context_prompt: 'Legacy false remains context-only.',
      activation: 'mention_then_continue',
    });

    const unauthorizedAgentChat = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}`, 'PATCH', memberSecret, {
      metadata: { agent_chat: { enabled: false, context_prompt: '', activation: 'mention_then_continue' } },
    });
    expect(unauthorizedAgentChat.res.status).toBe(403);
    const invalidAgentChat = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}`, 'PATCH', ownerSecret, {
      metadata: { agent_chat: { enabled: true, context_prompt: 'bad activation', activation: 'always' } },
    });
    expect(invalidAgentChat.res.status).toBe(400);

    const agentDirectMessagesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/messages`;
    const prepareMessageAttachment = async (fileName: string, bytes: Uint8Array) => {
      const prepared = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/storage/prepare`, 'POST', ownerSecret, {
        content_type: 'image/png',
        size_bytes: bytes.byteLength,
        file_name: fileName,
        owner_group_id: groupId,
        access_group_ids: [groupId],
      });
      expect(prepared.res.status).toBe(201);
      expect(prepared.json.owner_group_id).toBeNull();
      expect(prepared.json.access_group_ids).toEqual([]);
      expect(prepared.json.is_public).toBe(false);
      const objectId = prepared.json.object_id as string;
      expect(await writeStorageObject(objectId, bytes, OWNER_NPUB)).not.toBeNull();
      expect(await completeStorageObject(objectId, { size_bytes: bytes.byteLength, sha256_hex: sha256Hex(bytes) }, OWNER_NPUB)).not.toBeNull();
      return objectId;
    };

    const attachedBytes = new Uint8Array([137, 80, 78, 71, 1]);
    const attachedObjectId = await prepareMessageAttachment('message-image.png', attachedBytes);
    const humanBody = '@Agent please inspect this.';
    const humanMessage = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: humanBody,
      create_thread: true,
      thread_title: 'Agent Direct',
      metadata: {
        mentions: [{ type: 'agent', npub: AGENT_NPUB, label: 'Agent' }],
        attachments: [{ storage_object_id: attachedObjectId, kind: 'image', filename: 'message-image.png', content_type: 'image/png', size_bytes: attachedBytes.byteLength }],
      },
      message_signature: messageSignature({ body: humanBody, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(humanMessage.res.status).toBe(201);
    expect(humanMessage.json.message.mentions).toEqual([{ type: 'agent', actor_id: agentMember.json.actor.actor_id, npub: AGENT_NPUB, label: 'Agent' }]);
    expect(humanMessage.json.message.created_by_actor_id).toBe(ownerId);
    expect(humanMessage.json.attachment_links).toEqual([expect.objectContaining({ storage_object_id: attachedObjectId })]);
    const attachedContentPath = `/api/v4/storage/${attachedObjectId}/content`;
    const ownerAttachmentRead = await requestRaw(attachedContentPath, 'GET', ownerSecret);
    expect(ownerAttachmentRead.res.status).toBe(200);
    expect(ownerAttachmentRead.bytes).toEqual(attachedBytes);
    const channelMemberAttachmentRead = await requestRaw(attachedContentPath, 'GET', groupMemberSecret);
    expect(channelMemberAttachmentRead.res.status).toBe(200);
    expect(channelMemberAttachmentRead.bytes).toEqual(attachedBytes);
    const inaccessibleAttachmentRead = await requestJson(attachedContentPath, 'GET', inaccessibleAgentSecret);
    expect(inaccessibleAttachmentRead.res.status).toBe(404);

    const unassociatedBytes = new Uint8Array([137, 80, 78, 71, 2]);
    const unassociatedObjectId = await prepareMessageAttachment('owner-only-image.png', unassociatedBytes);
    const unassociatedOwnerRead = await requestRaw(`/api/v4/storage/${unassociatedObjectId}/content`, 'GET', ownerSecret);
    expect(unassociatedOwnerRead.res.status).toBe(200);
    const unassociatedMemberRead = await requestJson(`/api/v4/storage/${unassociatedObjectId}/content`, 'GET', groupMemberSecret);
    expect(unassociatedMemberRead.res.status).toBe(404);

    const publicBytes = new Uint8Array([137, 80, 78, 71, 3]);
    const publicPrepare = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/storage/prepare`, 'POST', ownerSecret, {
      content_type: 'image/png',
      size_bytes: publicBytes.byteLength,
      file_name: 'public-avatar.png',
      is_public: true,
      metadata: { purpose: 'workspace-profile/avatar' },
    });
    expect(publicPrepare.res.status).toBe(201);
    expect(publicPrepare.json.is_public).toBe(true);
    expect(await writeStorageObject(publicPrepare.json.object_id, publicBytes, OWNER_NPUB)).not.toBeNull();
    expect(await completeStorageObject(publicPrepare.json.object_id, { size_bytes: publicBytes.byteLength }, OWNER_NPUB)).not.toBeNull();
    const publicRead = await app.request(`/api/v4/storage/${publicPrepare.json.object_id}/content`);
    expect(publicRead.status).toBe(200);
    expect(new Uint8Array(await publicRead.arrayBuffer())).toEqual(publicBytes);

    const wrongWorkspaceStorage = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, file_name, content_type, storage_path, completed_at)
      VALUES ('npub1differentstorageworkspace', ${OWNER_NPUB}, 'wrong-workspace.png', 'image/png', 'v4/wrong-workspace.png', NOW())
      RETURNING id
    `;
    const wrongWorkspaceBody = 'This attachment belongs to a different storage workspace.';
    const wrongWorkspaceMessage = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: wrongWorkspaceBody,
      metadata: { attachments: [{ storage_object_id: wrongWorkspaceStorage[0]!.id }] },
      message_signature: messageSignature({ body: wrongWorkspaceBody, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(wrongWorkspaceMessage.res.status).toBe(400);
    expect(wrongWorkspaceMessage.json.details.fields).toContainEqual(expect.objectContaining({ code: 'workspace_mismatch' }));

    const agentDirectThreadId = humanMessage.json.thread.id as string;

    const literalBody = '@Agent is plain text only.';
    const literalMessage = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: literalBody,
      thread_id: agentDirectThreadId,
      message_signature: messageSignature({ body: literalBody, secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(literalMessage.res.status).toBe(201);
    expect(literalMessage.json.message.mentions).toEqual([]);

    const literalEditPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/messages/${literalMessage.json.message.id}`;
    const mentionedRevisionBody = '@Agent is now a structured mention.';
    const mentionedRevisionRequest = {
      body: mentionedRevisionBody,
      row_version: literalMessage.json.message.row_version,
      mentions: [{ type: 'agent', npub: AGENT_NPUB, label: 'Agent' }],
      message_signature: messageSignature({
        body: mentionedRevisionBody,
        secret: ownerSecret,
        workspaceId,
        channelId,
        threadId: agentDirectThreadId,
        messageId: literalMessage.json.message.id,
        revision: 2,
      }),
    };
    const mentionedRevision = await requestJson(literalEditPath, 'PATCH', ownerSecret, mentionedRevisionRequest);
    expect(mentionedRevision.res.status).toBe(200);
    expect(mentionedRevision.json.message.row_version).toBe(2);
    expect(mentionedRevision.json.newly_added_mentions).toEqual([{ type: 'agent', actor_id: agentMember.json.actor.actor_id, npub: AGENT_NPUB, label: 'Agent' }]);
    expect(mentionedRevision.json.revision_idempotency_key).toBe(`message:${literalMessage.json.message.id}:revision:2`);

    const revisionReplay = await requestJson(literalEditPath, 'PATCH', ownerSecret, mentionedRevisionRequest);
    expect(revisionReplay.res.status).toBe(409);
    expect(revisionReplay.json.code).toBe('stale_row_version');

    const nonAuthorRevision = await requestJson(literalEditPath, 'PATCH', agentSecret, {
      ...mentionedRevisionRequest,
      row_version: 2,
      message_signature: messageSignature({ body: mentionedRevisionBody, secret: agentSecret, workspaceId, channelId, threadId: agentDirectThreadId, messageId: literalMessage.json.message.id, revision: 3 }),
    });
    expect(nonAuthorRevision.res.status).toBe(403);
    expect(nonAuthorRevision.json.code).toBe('message_author_required');

    const wordingRevisionBody = '@Agent with revised wording.';
    const wordingRevision = await requestJson(literalEditPath, 'PATCH', ownerSecret, {
      body: wordingRevisionBody,
      row_version: 2,
      mentions: [{ type: 'person', npub: AGENT_NPUB }],
      metadata: { edit_source: 'composer' },
      message_signature: messageSignature({ body: wordingRevisionBody, secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId, messageId: literalMessage.json.message.id, revision: 3 }),
    });
    expect(wordingRevision.res.status).toBe(200);
    expect(wordingRevision.json.message.row_version).toBe(3);
    expect(wordingRevision.json.message.metadata.edit_source).toBe('composer');
    expect(wordingRevision.json.newly_added_mentions).toEqual([]);

    const badRevisionSignature = await requestJson(literalEditPath, 'PATCH', ownerSecret, {
      body: 'Bad revision binding.',
      row_version: 3,
      mentions: [],
      message_signature: messageSignature({ body: 'Bad revision binding.', secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId, messageId: literalMessage.json.message.id, revision: 99 }),
    });
    expect(badRevisionSignature.res.status).toBe(400);
    expect(badRevisionSignature.json.details.fields).toContainEqual(expect.objectContaining({ path: 'message_signature.nostr_event.tags.revision', code: 'invalid' }));

    const revisionEvents = await sql<{ event_type: string; entity_row_version: string; payload: Record<string, unknown> }[]>`
      SELECT event_type, entity_row_version, payload
      FROM flightdeck_pg_outbox_events
      WHERE workspace_id = ${workspaceId}
        AND entity_id = ${literalMessage.json.message.id}
        AND event_type = 'flightdeck_pg.message.revised'
      ORDER BY entity_row_version
    `;
    expect(revisionEvents).toHaveLength(2);
    expect(revisionEvents[0]).toMatchObject({
      event_type: 'flightdeck_pg.message.revised',
      entity_row_version: '2',
      payload: {
        event_type: 'message.revised',
        message_id: literalMessage.json.message.id,
        revision: 2,
        revision_idempotency_key: `message:${literalMessage.json.message.id}:revision:2`,
        newly_added_mentions: [{ actor_id: agentMember.json.actor.actor_id, npub: AGENT_NPUB }],
      },
    });
    expect(revisionEvents[1]).toMatchObject({ entity_row_version: '3', payload: { newly_added_mentions: [] } });

    const attachmentOnlyObjectId = await prepareMessageAttachment('attachment-only.png', new Uint8Array([3, 2, 1]));
    const attachmentOnlyMessage = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: '',
      thread_id: agentDirectThreadId,
      metadata: { attachments: [{ storage_object_id: attachmentOnlyObjectId }] },
      message_signature: messageSignature({ body: '', secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(attachmentOnlyMessage.res.status).toBe(201);
    expect(attachmentOnlyMessage.json.message.attachments).toEqual([{ storage_object_id: attachmentOnlyObjectId }]);

    await sql`
      UPDATE flightdeck_pg_storage_links
      SET deleted_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND entity_type = 'message'
        AND entity_id = ${attachmentOnlyMessage.json.message.id}
        AND storage_object_id = ${attachmentOnlyObjectId}
        AND deleted_at IS NULL
    `;
    const preRepairRead = await requestJson(`/api/v4/storage/${attachmentOnlyObjectId}/content`, 'GET', groupMemberSecret);
    expect(preRepairRead.res.status).toBe(404);
    const repairPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/messages/${attachmentOnlyMessage.json.message.id}/attachments/repair`;
    const firstRepair = await requestJson(repairPath, 'POST', ownerSecret, {});
    expect(firstRepair.res.status).toBe(200);
    expect(firstRepair.json.repair).toMatchObject({ created: 1, retained: 0, tombstoned: 0, idempotent: false });
    const secondRepair = await requestJson(repairPath, 'POST', ownerSecret, {});
    expect(secondRepair.res.status).toBe(200);
    expect(secondRepair.json.repair).toMatchObject({ created: 0, retained: 1, tombstoned: 0, idempotent: true });
    const postRepairRead = await requestRaw(`/api/v4/storage/${attachmentOnlyObjectId}/content`, 'GET', groupMemberSecret);
    expect(postRepairRead.res.status).toBe(200);

    const humanActorBody = 'Mention a human actor.';
    const humanActorMention = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: humanActorBody,
      thread_id: agentDirectThreadId,
      metadata: { mentions: [{ type: 'person', npub: MEMBER_NPUB }] },
      message_signature: messageSignature({ body: humanActorBody, secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(humanActorMention.res.status).toBe(201);
    expect(humanActorMention.json.message.mentions).toEqual([{ type: 'agent', actor_id: memberCreate.json.actor.actor_id, npub: MEMBER_NPUB, label: 'Channel Member Refreshed' }]);
    const malformedMention = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: humanActorBody,
      thread_id: agentDirectThreadId,
      metadata: { mentions: [{ type: 'agent', npub: 'not-an-npub' }] },
      message_signature: messageSignature({ body: humanActorBody, secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(malformedMention.res.status).toBe(400);
    const unknownMention = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: humanActorBody,
      thread_id: agentDirectThreadId,
      metadata: { mentions: [{ type: 'agent', npub: UNKNOWN_AGENT_NPUB }] },
      message_signature: messageSignature({ body: humanActorBody, secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(unknownMention.res.status).toBe(400);
    const inaccessibleBody = 'Mention inaccessible agent.';
    const inaccessibleMention = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: inaccessibleBody,
      thread_id: agentDirectThreadId,
      metadata: { mentions: [{ type: 'agent', npub: INACCESSIBLE_AGENT_NPUB }] },
      message_signature: messageSignature({ body: inaccessibleBody, secret: ownerSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(inaccessibleMention.res.status).toBe(400);

    const replyBody = 'I inspected it.';
    const replyRequest = {
      body: replyBody,
      thread_id: agentDirectThreadId,
      client_request_id: 'agentdirect:test-route:turn-1',
      metadata: { source: 'autopilot_session', created_by_actor_id: ownerId, sender_npub: OWNER_NPUB },
      message_signature: messageSignature({ body: replyBody, secret: agentSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    };
    const agentReply = await requestJson(agentDirectMessagesPath, 'POST', agentSecret, replyRequest);
    expect(agentReply.res.status).toBe(201);
    expect(agentReply.json.created).toBe(true);
    expect(agentReply.json.message.created_by_actor_id).toBe(agentMember.json.actor.actor_id);
    expect(agentReply.json.message.created_by_actor_npub).toBe(AGENT_NPUB);
    const threadPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/threads/${agentDirectThreadId}`;
    const agentThreadRead = await requestJson(threadPath, 'GET', agentSecret);
    expect(agentThreadRead.res.status).toBe(200);
    expect(agentThreadRead.json.thread.title).not.toContain('mention:');
    const agentRename = await requestJson(threadPath, 'PATCH', agentSecret, { title: '  Agent renamed\nthread  ', row_version: agentThreadRead.json.thread.row_version });
    expect(agentRename.res.status).toBe(200);
    expect(agentRename.json.thread.title).toBe('Agent renamed thread');
    const ownerThreadRead = await requestJson(threadPath, 'GET', ownerSecret);
    expect(ownerThreadRead.json.thread.title).toBe('Agent renamed thread');
    const deniedThreadRead = await requestJson(threadPath, 'GET', inaccessibleAgentSecret);
    expect(deniedThreadRead.res.status).toBe(403);
    const tooLongRename = await requestJson(threadPath, 'PATCH', ownerSecret, { title: 'x'.repeat(121) });
    expect(tooLongRename.res.status).toBe(400);
    const replyReplay = await requestJson(agentDirectMessagesPath, 'POST', agentSecret, replyRequest);
    expect(replyReplay.res.status).toBe(200);
    expect(replyReplay.json.replayed).toBe(true);
    expect(replyReplay.json.message.id).toBe(agentReply.json.message.id);
    const replyConflict = await requestJson(agentDirectMessagesPath, 'POST', agentSecret, { ...replyRequest, body: 'Different answer.', message_signature: messageSignature({ body: 'Different answer.', secret: agentSecret, workspaceId, channelId, threadId: agentDirectThreadId }) });
    expect(replyConflict.res.status).toBe(409);

    const deniedAgentBody = 'I should not write.';
    const deniedAgentReply = await requestJson(agentDirectMessagesPath, 'POST', inaccessibleAgentSecret, {
      body: deniedAgentBody,
      thread_id: agentDirectThreadId,
      message_signature: messageSignature({ body: deniedAgentBody, secret: inaccessibleAgentSecret, workspaceId, channelId, threadId: agentDirectThreadId }),
    });
    expect(deniedAgentReply.res.status).toBe(403);

    const firstThreadPage = await requestJson(`${agentDirectMessagesPath}?thread_id=${agentDirectThreadId}&limit=3`, 'GET', ownerSecret);
    expect(firstThreadPage.res.status).toBe(200);
    expect(firstThreadPage.json.messages).toHaveLength(3);
    expect(firstThreadPage.json.next_cursor).toBeString();
    const secondThreadPage = await requestJson(`${agentDirectMessagesPath}?thread_id=${agentDirectThreadId}&limit=3&cursor=${encodeURIComponent(firstThreadPage.json.next_cursor)}`, 'GET', ownerSecret);
    expect(secondThreadPage.res.status).toBe(200);
    expect(secondThreadPage.json.messages.map((message: any) => message.id)).not.toContain(firstThreadPage.json.messages[1].id);
    expect([...firstThreadPage.json.messages, ...secondThreadPage.json.messages].map((message: any) => message.id)).toEqual(expect.arrayContaining([humanMessage.json.message.id, literalMessage.json.message.id, agentReply.json.message.id]));
    expect(secondThreadPage.json.messages.find((message: any) => message.id === agentReply.json.message.id)).toMatchObject({
      created_by_actor_npub: AGENT_NPUB,
      created_by_actor_label: 'Agent',
      attachments: [],
    });
    const [createdEventCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM flightdeck_pg_outbox_events
      WHERE workspace_id = ${workspaceId} AND entity_type = 'message' AND entity_id = ${agentReply.json.message.id}
    `;
    expect(Number(createdEventCount.count)).toBe(1);
    const events = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events`, 'GET', ownerSecret);
    const humanEvent = events.json.events.find((event: any) => event.entity_id === humanMessage.json.message.id);
    expect(humanEvent).toMatchObject({ workspace_id: workspaceId, channel_id: channelId, actor_id: ownerId, actor_npub: OWNER_NPUB });
    expect(humanEvent.payload).toMatchObject({ thread_id: agentDirectThreadId, mentions: [{ actor_id: agentMember.json.actor.actor_id, npub: AGENT_NPUB }] });
    const humanActorMentionEvent = events.json.events.find((event: any) => event.entity_id === humanActorMention.json.message.id);
    expect(humanActorMentionEvent.payload).toMatchObject({
      thread_id: agentDirectThreadId,
      mentions: [{ type: 'agent', actor_id: memberCreate.json.actor.actor_id, npub: MEMBER_NPUB }],
    });


    const siblingThreadBody = 'Wrong target seed.';
    const siblingThreadMessage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${siblingChannelId}/messages`, 'POST', ownerSecret, {
      body: siblingThreadBody,
      create_thread: true,
      message_signature: messageSignature({ body: siblingThreadBody, secret: ownerSecret, workspaceId, channelId: siblingChannelId }),
    });
    expect(siblingThreadMessage.res.status).toBe(201);

    const [searchParentGroup] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspaceId}, 'Search Parent', 'custom', ${ownerId}) RETURNING id
    `;
    const [searchChildGroup] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspaceId}, 'Search Child', 'custom', ${ownerId}) RETURNING id
    `;
    await sql`UPDATE flightdeck_pg_scopes SET owner_group_id = ${searchParentGroup.id} WHERE workspace_id = ${workspaceId} AND id = ${scopeId}`;
    await sql`
      INSERT INTO flightdeck_pg_group_edges (workspace_id, parent_group_id, child_group_id, created_by_actor_id)
      VALUES (${workspaceId}, ${searchParentGroup.id}, ${searchChildGroup.id}, ${ownerId})
    `;
    const childScope = await requestJson(scopesPath, 'POST', ownerSecret, { name: 'Search Descendant', kind: 'project', owner_group_id: searchChildGroup.id });
    expect(childScope.res.status).toBe(201);
    const childChannelsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${childScope.json.scope.id}/channels`;
    const childChannel = await requestJson(childChannelsPath, 'POST', ownerSecret, { name: 'Descendant Search', kind: 'channel' });
    expect(childChannel.res.status).toBe(201);
    const descendantBody = 'Needle in descendant scope';
    const descendantMessage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${childChannel.json.channel.id}/messages`, 'POST', ownerSecret, {
      body: descendantBody,
      message_signature: messageSignature({ body: descendantBody, secret: ownerSecret, workspaceId, channelId: childChannel.json.channel.id }),
    });
    expect(descendantMessage.res.status).toBe(201);
    const descendantSearch = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/search?q=descendant&scope_id=${scopeId}&mode=subtree&limit=5`, 'GET', ownerSecret);
    expect(descendantSearch.res.status).toBe(200);
    expect(descendantSearch.json.results.map((item: any) => item.id)).toContain(descendantMessage.json.message.id);

    const searchPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/search?q=${encodeURIComponent('Wrong target')}&scope_id=${scopeId}&mode=subtree&limit=5`;
    const ownerSearch = await requestJson(searchPath, 'GET', ownerSecret);
    expect(ownerSearch.res.status).toBe(200);
    expect(ownerSearch.json.mode).toBe('subtree');
    expect(ownerSearch.json.results.length).toBeLessThanOrEqual(5);
    expect(ownerSearch.json.results).toContainEqual(expect.objectContaining({
      id: siblingThreadMessage.json.message.id,
      record_type: 'message',
      scope_id: scopeId,
      channel_id: siblingChannelId,
      navigation_target: expect.objectContaining({ action: 'open-thread', thread_id: siblingThreadMessage.json.thread.id }),
    }));

    const memberSearch = await requestJson(searchPath, 'GET', memberSecret);
    expect(memberSearch.res.status).toBe(200);
    expect(memberSearch.json.results.map((item: any) => item.id)).not.toContain(siblingThreadMessage.json.message.id);

    const outsideSearch = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/search?q=Wrong&scope_id=${scopeId}&mode=outside_subtree&limit=5`, 'GET', ownerSecret);
    expect(outsideSearch.res.status).toBe(200);
    expect(outsideSearch.json.results).toEqual([]);

    const limitedSearch = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/search?q=target&mode=workspace&limit=1`, 'GET', ownerSecret);
    expect(limitedSearch.res.status).toBe(200);
    expect(limitedSearch.json.results).toHaveLength(1);

    const exactTitleSearch = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/search?q=${encodeURIComponent('Agent renamed thread')}&mode=workspace&limit=5`, 'GET', ownerSecret);
    expect(exactTitleSearch.res.status).toBe(200);
    expect(exactTitleSearch.json.results[0]).toMatchObject({ title: 'Agent renamed thread', relevance: 500 });

    await sql`UPDATE flightdeck_pg_threads SET archived_at = NOW() WHERE workspace_id = ${workspaceId} AND id = ${siblingThreadMessage.json.thread.id}`;
    const archivedSearch = await requestJson(searchPath, 'GET', ownerSecret);
    expect(archivedSearch.res.status).toBe(200);
    expect(archivedSearch.json.results.map((item: any) => item.id)).not.toContain(siblingThreadMessage.json.message.id);
    await sql`UPDATE flightdeck_pg_threads SET archived_at = NULL WHERE workspace_id = ${workspaceId} AND id = ${siblingThreadMessage.json.thread.id}`;

    const tooShortSearch = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/search?q=x&mode=workspace`, 'GET', ownerSecret);
    expect(tooShortSearch.res.status).toBe(400);
    expect(tooShortSearch.json.details.fields).toContainEqual(expect.objectContaining({ path: 'q', code: 'too_short' }));
    const wrongThreadBody = 'Wrong channel target.';
    const wrongThread = await requestJson(agentDirectMessagesPath, 'POST', ownerSecret, {
      body: wrongThreadBody,
      thread_id: siblingThreadMessage.json.thread.id,
      message_signature: messageSignature({ body: wrongThreadBody, secret: ownerSecret, workspaceId, channelId, threadId: siblingThreadMessage.json.thread.id }),
    });
    expect(wrongThread.res.status).toBe(404);

    const memberDeniedGrantsList = await requestJson(grantsPath, 'GET', memberSecret);
    expect(memberDeniedGrantsList.res.status).toBe(403);
    expect(memberDeniedGrantsList.json.required_permission).toBe('channel.grants.read');

    const groupMemberDeniedGrantCreate = await requestJson(grantsPath, 'POST', groupMemberSecret, {
      principal_type: 'person',
      principal_id: memberCreate.json.actor.actor_id,
      access_level: 'manage',
    });
    expect(groupMemberDeniedGrantCreate.res.status).toBe(403);
    expect(groupMemberDeniedGrantCreate.json.required_permission).toBe('channel.grants.manage');

    const groupMemberDeniedGrantUpdate = await requestJson(`${grantsPath}/group/${groupId}`, 'PUT', groupMemberSecret, {
      access_level: 'manage',
    });
    expect(groupMemberDeniedGrantUpdate.res.status).toBe(403);
    expect(groupMemberDeniedGrantUpdate.json.required_permission).toBe('channel.grants.manage');

    const memberDeniedGrantDelete = await requestJson(`${grantsPath}/person/${memberCreate.json.actor.actor_id}`, 'DELETE', memberSecret);
    expect(memberDeniedGrantDelete.res.status).toBe(403);
    expect(memberDeniedGrantDelete.json.required_permission).toBe('channel.grants.manage');

    const initialGrantChannel = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Initial Grants',
      kind: 'channel',
      grants: [{ principal_type: 'group', principal_id: groupId, access_level: 'view' }],
    });
    expect(initialGrantChannel.res.status).toBe(201);
    const initialGrantsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${initialGrantChannel.json.channel.id}/grants`;
    const initialGrantList = await requestJson(initialGrantsPath, 'GET', ownerSecret);
    expect(initialGrantList.res.status).toBe(200);
    expect(initialGrantList.json.grants.some((grant: any) => grant.principal_type === 'group' && grant.principal_id === groupId && grant.access_level === 'view')).toBe(true);

    const grantsList = await requestJson(grantsPath, 'GET', ownerSecret);
    expect(grantsList.res.status).toBe(200);
    expectFixtureRequiredKeys(grantsList.json, 'channel-grants-list.json');
    expect(grantsList.json.grants.map((grant: any) => grant.access_level)).toEqual(expect.arrayContaining(['view', 'contribute']));
    const ownerChannelPermissions = grantsList.json.grants
      .find((grant: any) => grant.principal_type === 'person' && grant.principal_id === ownerId)
      ?.permissions ?? [];
    expect(ownerChannelPermissions).toEqual(expect.arrayContaining([
      'channel.read',
      'channel.write',
      'channel.grants.manage',
      'task.read',
      'task.create',
      'doc.read',
      'file.read',
      'audio_note.read',
    ]));

    const groupGrantUpdate = await requestJson(`${grantsPath}/group/${groupId}`, 'PUT', ownerSecret, {
      access_level: 'manage',
    });
    expect(groupGrantUpdate.res.status).toBe(200);
    expect(groupGrantUpdate.json.grant.access_level).toBe('manage');
    expect(groupGrantUpdate.json.grant.permissions).toEqual(expect.arrayContaining(['channel.manage', 'channel.grants.read', 'channel.grants.manage']));

    const groupGrantDelete = await requestJson(`${initialGrantsPath}/group/${groupId}`, 'DELETE', ownerSecret);
    expect(groupGrantDelete.res.status).toBe(200);
    expect(groupGrantDelete.json.revoked).toBeGreaterThan(0);

    const memberScopes = await requestJson(scopesPath, 'GET', memberSecret);
    expect(memberScopes.res.status).toBe(200);
    expect(memberScopes.json.scopes.map((scope: any) => scope.id)).toContain(scopeId);

    const memberChannels = await requestJson(channelsPath, 'GET', memberSecret);
    expect(memberChannels.res.status).toBe(200);
    const memberChannelIds = memberChannels.json.channels.map((channel: any) => channel.id);
    expect(memberChannelIds).toContain(channelId);
    expect(memberChannelIds).not.toContain(siblingChannelId);

    const groupMemberChannels = await requestJson(channelsPath, 'GET', groupMemberSecret);
    expect(groupMemberChannels.res.status).toBe(200);
    expect(groupMemberChannels.json.channels.map((channel: any) => channel.id)).toContain(channelId);
    expect(groupMemberChannels.json.channels.map((channel: any) => channel.id)).not.toContain(siblingChannelId);

    const dmNonMemberCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Owner and isolated participant DM',
      description: 'Private DM that is the only visible channel for the other participant.',
      kind: 'dm',
      participant_npubs: [OWNER_NPUB, DM_ONLY_NPUB],
    });
    expect(dmNonMemberCreate.res.status).toBe(403);
    expect(dmNonMemberCreate.json.code).toBe('dm_participant_not_member');

    const dmOnlyMemberCreate = await requestJson(memberPath, 'POST', ownerSecret, {
      member_npub: DM_ONLY_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'DM Only Participant',
    });
    expect(dmOnlyMemberCreate.res.status).toBe(201);

    const dmOnlyCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Owner and isolated participant DM',
      description: 'Private DM that is the only visible channel for the other participant.',
      kind: 'dm',
      participant_npubs: [OWNER_NPUB, DM_ONLY_NPUB],
    });
    expect(dmOnlyCreate.res.status).toBe(201);
    expect(dmOnlyCreate.json.channel.participant_npubs).toEqual(expect.arrayContaining([OWNER_NPUB, DM_ONLY_NPUB]));
    const dmOnlyChannelId = dmOnlyCreate.json.channel.id as string;

    const [dmOnlyScopeGrant] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_permission_grants pg
      JOIN flightdeck_pg_actors a ON a.id = pg.principal_actor_id
      WHERE pg.workspace_id = ${workspaceId}
        AND a.npub = ${DM_ONLY_NPUB}
        AND pg.resource_type = 'scope'
        AND pg.resource_scope_id = ${scopeId}
        AND pg.revoked_at IS NULL
    `;
    expect(Number(dmOnlyScopeGrant.count)).toBe(0);

    const dmOnlyScopes = await requestJson(scopesPath, 'GET', dmOnlySecret);
    expect(dmOnlyScopes.res.status).toBe(200);
    expect(dmOnlyScopes.json.scopes.map((scope: any) => scope.id)).toContain(scopeId);

    const dmOnlyChannels = await requestJson(channelsPath, 'GET', dmOnlySecret);
    expect(dmOnlyChannels.res.status).toBe(200);
    expect(dmOnlyChannels.json.channels.map((channel: any) => channel.id)).toEqual([dmOnlyChannelId]);

    const dmCreate = await requestJson(channelsPath, 'POST', ownerSecret, {
      name: 'Owner and member DM',
      description: 'Private two-participant DM',
      kind: 'dm',
      participant_npubs: [OWNER_NPUB, MEMBER_NPUB],
    });
    expect(dmCreate.res.status).toBe(201);
    const dmChannelId = dmCreate.json.channel.id as string;
    expect(dmCreate.json.channel.kind).toBe('dm');

    const [memberScopeGrant] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${workspaceId}
        AND principal_actor_id = ${memberCreate.json.actor.actor_id}
        AND resource_type = 'scope'
        AND resource_scope_id = ${scopeId}
        AND revoked_at IS NULL
    `;
    expect(Number(memberScopeGrant.count)).toBe(0);

    const [dmGrantRows] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_permission_grants pg
      JOIN flightdeck_pg_actors a ON a.id = pg.principal_actor_id
      WHERE pg.workspace_id = ${workspaceId}
        AND pg.resource_type = 'channel'
        AND pg.resource_channel_id = ${dmChannelId}
        AND pg.revoked_at IS NULL
        AND a.npub IN (${OWNER_NPUB}, ${MEMBER_NPUB})
        AND pg.permission IN ('channel.read', 'channel.write', 'channel.manage', 'channel.grants.read', 'channel.grants.manage')
    `;
    expect(Number(dmGrantRows.count)).toBe(10);

    const memberDmScopes = await requestJson(scopesPath, 'GET', memberSecret);
    expect(memberDmScopes.res.status).toBe(200);
    expect(memberDmScopes.json.scopes.map((scope: any) => scope.id)).toContain(scopeId);

    const memberDmChannels = await requestJson(channelsPath, 'GET', memberSecret);
    expect(memberDmChannels.res.status).toBe(200);
    expect(memberDmChannels.json.channels.map((channel: any) => channel.id)).toContain(dmChannelId);

    const groupMemberDmChannels = await requestJson(channelsPath, 'GET', groupMemberSecret);
    expect(groupMemberDmChannels.res.status).toBe(200);
    expect(groupMemberDmChannels.json.channels.map((channel: any) => channel.id)).not.toContain(dmChannelId);

    const dmMessagesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${dmChannelId}/messages`;
    const memberDmMessageBody = 'Member can write in the jointly managed DM.';
    const memberDmMessage = await requestJson(dmMessagesPath, 'POST', memberSecret, {
      body: memberDmMessageBody,
      message_signature: messageSignature({ body: memberDmMessageBody, secret: memberSecret, workspaceId, channelId: dmChannelId }),
    });
    expect(memberDmMessage.res.status).toBe(201);

    const memberDmGrants = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${dmChannelId}/grants`, 'GET', memberSecret);
    expect(memberDmGrants.res.status).toBe(200);
    const memberDmGrant = memberDmGrants.json.grants
      .find((grant: any) => grant.stored_principal_type === 'actor' && grant.principal_id === memberCreate.json.actor.actor_id);
    expect(memberDmGrant.principal_type).toBe('person');
    expect(memberDmGrant.principal.type).toBe('person');
    expect(memberDmGrant.access_level).toBe('manage');
    const memberDmPermissions = memberDmGrant.permissions ?? [];
    expect(memberDmPermissions).toEqual(expect.arrayContaining([
      'channel.read',
      'channel.write',
      'channel.manage',
      'channel.grants.read',
      'channel.grants.manage',
    ]));
    expect(memberDmPermissions).not.toContain('daily_note.read');
    expect(memberDmPermissions).not.toContain('daily_note.write');

    const dailyNotesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/daily-notes`;
    const ownerDailyNote = await requestJson(dailyNotesPath, 'POST', ownerSecret, {
      note_date: '2026-06-13',
      title: 'Saturday focus',
      body: 'Morning walk summary',
      focus: 'Ship the Flight Deck PG daily note migration.',
      items: [
        { id: 'focus-1', text: 'Ship Daily Scope contract', completed: false },
        { id: 'focus-2', text: 'Review Flight Deck hydration', completed: true },
      ],
      status: 'active',
      metadata: { source: 'test' },
    });
    expect(ownerDailyNote.res.status).toBe(201);
    const dailyNoteId = ownerDailyNote.json.daily_note.id as string;
    expect(ownerDailyNote.json.daily_note.owner_actor_id).toBe(ownerId);
    expect(ownerDailyNote.json.daily_note.owner_actor_npub).toBe(OWNER_NPUB);
    expect(ownerDailyNote.json.daily_note.scope_id).toBeNull();
    expect(ownerDailyNote.json.daily_note.channel_id).toBeNull();
    expect(ownerDailyNote.json.daily_note.items).toHaveLength(2);

    const ownerDailyNoteWithStaleScopeMetadata = await requestJson(dailyNotesPath, 'POST', ownerSecret, {
      note_date: '2026-06-15',
      title: 'Personal focus with stale metadata',
      body: 'This remains personal even if older clients send scoped metadata.',
      focus: '',
      items: [],
      status: 'active',
      metadata: { source: 'test', scope_id: scopeId, channel_id: dmChannelId },
    });
    expect(ownerDailyNoteWithStaleScopeMetadata.res.status).toBe(201);
    expect(ownerDailyNoteWithStaleScopeMetadata.json.daily_note.scope_id).toBeNull();
    expect(ownerDailyNoteWithStaleScopeMetadata.json.daily_note.channel_id).toBeNull();

    const ownerDailyNoteUpdate = await requestJson(dailyNotesPath, 'POST', ownerSecret, {
      note_date: '2026-06-13',
      title: 'Saturday focus',
      body: 'Morning walk summary updated by the owner.',
      focus: 'Make Daily Scope personal by owner and date.',
      items: [],
      status: 'active',
      metadata: { source: 'test', edited_by: 'owner' },
    });
    expect(ownerDailyNoteUpdate.res.status).toBe(200);
    expect(ownerDailyNoteUpdate.json.daily_note.id).toBe(dailyNoteId);
    expect(ownerDailyNoteUpdate.json.daily_note.owner_actor_id).toBe(ownerId);
    expect(ownerDailyNoteUpdate.json.daily_note.updated_by_actor_id).toBe(ownerId);
    expect(ownerDailyNoteUpdate.json.daily_note.row_version).toBe(2);

    const secondOwnerSameDateUpsert = await requestJson(dailyNotesPath, 'POST', ownerSecret, {
      note_date: '2026-06-13',
      title: 'Saturday refocus',
      body: 'Second owner write on same date still upserts.',
      focus: 'Owner/date conflict target',
      items: [],
      status: 'active',
    });
    expect(secondOwnerSameDateUpsert.res.status).toBe(200);
    expect(secondOwnerSameDateUpsert.json.daily_note.id).toBe(dailyNoteId);
    expect(secondOwnerSameDateUpsert.json.daily_note.row_version).toBe(3);

    const differentOwnerSameDate = await requestJson(dailyNotesPath, 'POST', groupMemberSecret, {
      note_date: '2026-06-13',
      title: 'Group member scope',
      body: 'Same date, different owner.',
      focus: 'Separate owner/date row',
      items: [],
      status: 'active',
    });
    expect(differentOwnerSameDate.res.status).toBe(201);
    expect(differentOwnerSameDate.json.daily_note.id).not.toBe(dailyNoteId);
    expect(differentOwnerSameDate.json.daily_note.owner_actor_id).toBe(groupMemberId);

    const tooManyDailyScopeItems = await requestJson(dailyNotesPath, 'POST', ownerSecret, {
      note_date: '2026-06-14',
      title: 'Too many',
      items: [
        { text: 'One' },
        { text: 'Two' },
        { text: 'Three' },
        { text: 'Four' },
        { text: 'Five' },
        { text: 'Six' },
      ],
    });
    expect(tooManyDailyScopeItems.res.status).toBe(400);
    expect(JSON.stringify(tooManyDailyScopeItems.json)).toContain('five');

    const memberDailyNotesBeforeGrant = await requestJson(`${dailyNotesPath}?note_date=2026-06-13&owner_actor_id=${ownerId}`, 'GET', memberSecret);
    expect(memberDailyNotesBeforeGrant.res.status).toBe(200);
    expect(memberDailyNotesBeforeGrant.json.daily_notes.map((note: any) => note.id)).not.toContain(dailyNoteId);

    const memberDailyNoteReadBeforeGrant = await requestJson(`${dailyNotesPath}/${dailyNoteId}`, 'GET', memberSecret);
    expect(memberDailyNoteReadBeforeGrant.res.status).toBe(403);
    expect(memberDailyNoteReadBeforeGrant.json.required_permission).toBe('daily_note.read');

    const memberDailyNoteWriteBeforeGrant = await requestJson(dailyNotesPath, 'POST', memberSecret, {
      owner_actor_id: ownerId,
      note_date: '2026-06-13',
      title: 'Blocked',
      body: '',
      focus: '',
      items: [],
      status: 'active',
    });
    expect(memberDailyNoteWriteBeforeGrant.res.status).toBe(403);
    expect(memberDailyNoteWriteBeforeGrant.json.required_permission).toBe('daily_note.write');

    const accessPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/daily-scope/agent-access`;
    const ownerAccessListBeforeGrant = await requestJson(accessPath, 'GET', ownerSecret);
    expect(ownerAccessListBeforeGrant.res.status).toBe(200);
    expect(ownerAccessListBeforeGrant.json.access).toEqual([]);

    const grantDailyScopeAccess = await requestJson(accessPath, 'POST', ownerSecret, {
      agent_actor_id: memberCreate.json.actor.actor_id,
      can_read: true,
      can_write: true,
    });
    expect(grantDailyScopeAccess.res.status).toBe(201);
    expect(grantDailyScopeAccess.json.access.agent_actor_id).toBe(memberCreate.json.actor.actor_id);
    expect(grantDailyScopeAccess.json.access.can_read).toBe(true);
    expect(grantDailyScopeAccess.json.access.can_write).toBe(true);

    const memberDailyNotesAfterGrant = await requestJson(`${dailyNotesPath}?note_date=2026-06-13&owner_actor_id=${ownerId}`, 'GET', memberSecret);
    expect(memberDailyNotesAfterGrant.res.status).toBe(200);
    expect(memberDailyNotesAfterGrant.json.daily_notes.map((note: any) => note.id)).toContain(dailyNoteId);

    const memberDailyNoteUpdate = await requestJson(dailyNotesPath, 'POST', memberSecret, {
      owner_actor_id: ownerId,
      note_date: '2026-06-13',
      title: 'Saturday focus',
      body: 'Morning walk summary updated by the authorized agent.',
      focus: 'Agent can help with explicitly shared Daily Scope.',
      items: [{ id: 'agent-1', text: 'Confirm agent access path', completed: false, source: 'agent' }],
      status: 'active',
      metadata: { source: 'test', edited_by: 'member' },
    });
    expect(memberDailyNoteUpdate.res.status).toBe(200);
    expect(memberDailyNoteUpdate.json.daily_note.id).toBe(dailyNoteId);
    expect(memberDailyNoteUpdate.json.daily_note.owner_actor_id).toBe(ownerId);
    expect(memberDailyNoteUpdate.json.daily_note.updated_by_actor_id).toBe(memberCreate.json.actor.actor_id);
    expect(memberDailyNoteUpdate.json.daily_note.row_version).toBe(4);

    const ownerDailyNotesAfterMemberEdit = await requestJson(`${dailyNotesPath}?note_date=2026-06-13&owner_actor_id=${ownerId}`, 'GET', ownerSecret);
    expect(ownerDailyNotesAfterMemberEdit.res.status).toBe(200);
    const sharedDailyNote = ownerDailyNotesAfterMemberEdit.json.daily_notes.find((note: any) => note.id === dailyNoteId);
    expect(sharedDailyNote.body).toBe('Morning walk summary updated by the authorized agent.');
    expect(sharedDailyNote.focus).toBe('Agent can help with explicitly shared Daily Scope.');

    const ownerEventsAfterAgentEdit = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=50`, 'GET', ownerSecret);
    expect(ownerEventsAfterAgentEdit.res.status).toBe(200);
    expect(ownerEventsAfterAgentEdit.json.events.some((event: any) =>
      event.entity_type === 'daily_note'
      && event.entity_id === dailyNoteId
      && event.payload?.owner_actor_id === ownerId
      && event.payload?.updated_by_actor_id === memberCreate.json.actor.actor_id
    )).toBe(true);

    const memberEventsAfterGrant = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=50`, 'GET', memberSecret);
    expect(memberEventsAfterGrant.res.status).toBe(200);
    expect(memberEventsAfterGrant.json.events.some((event: any) => event.entity_type === 'daily_note' && event.entity_id === dailyNoteId)).toBe(true);

    const groupMemberEvents = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=50`, 'GET', groupMemberSecret);
    expect(groupMemberEvents.res.status).toBe(200);
    expect(groupMemberEvents.json.events.some((event: any) => event.entity_type === 'daily_note' && event.entity_id === dailyNoteId)).toBe(false);

    const revokeDailyScopeAccess = await requestJson(`${accessPath}/${memberCreate.json.actor.actor_id}`, 'DELETE', ownerSecret);
    expect(revokeDailyScopeAccess.res.status).toBe(200);
    expect(revokeDailyScopeAccess.json.revoked).toBe(true);

    const memberDailyNoteReadAfterRevoke = await requestJson(`${dailyNotesPath}/${dailyNoteId}`, 'GET', memberSecret);
    expect(memberDailyNoteReadAfterRevoke.res.status).toBe(403);
    expect(memberDailyNoteReadAfterRevoke.json.required_permission).toBe('daily_note.read');

    const memberDailyNoteWriteAfterRevoke = await requestJson(dailyNotesPath, 'POST', memberSecret, {
      owner_actor_id: ownerId,
      note_date: '2026-06-13',
      title: 'Blocked after revoke',
      body: '',
      focus: '',
      items: [],
      status: 'active',
    });
    expect(memberDailyNoteWriteAfterRevoke.res.status).toBe(403);
    expect(memberDailyNoteWriteAfterRevoke.json.required_permission).toBe('daily_note.write');

    const memberTaskGrant = await requestJson(grantsPath, 'POST', ownerSecret, {
      principal_type: 'actor',
      principal_id: memberCreate.json.actor.actor_id,
      permissions: ['task.read', 'task.update', 'task.comment'],
    });
    expect(memberTaskGrant.res.status).toBe(201);

    const messagesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/messages`;
    const threadsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads`;
    const memberDeniedMessageBody = 'Member can read chat but cannot write without channel.write.';
    const memberDeniedMessage = await requestJson(messagesPath, 'POST', memberSecret, {
      body: memberDeniedMessageBody,
      message_signature: messageSignature({ body: memberDeniedMessageBody, secret: memberSecret, workspaceId, channelId }),
    });
    expect(memberDeniedMessage.res.status).toBe(403);
    expect(memberDeniedMessage.json.required_permission).toBe('channel.write');

    const rootMessageBody = 'Typed channel chat is now backed by Tower Postgres.';
    const rootMessage = await requestJson(messagesPath, 'POST', ownerSecret, {
      body: rootMessageBody,
      create_thread: true,
      thread_title: 'Typed chat backend',
      metadata: { source: 'test' },
      message_signature: messageSignature({ body: rootMessageBody, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(rootMessage.res.status).toBe(201);
    expectFixtureRequiredKeys(rootMessage.json, 'channel-messages-create.json');
    expect(rootMessage.json.message.body).toBe('Typed channel chat is now backed by Tower Postgres.');
    expect(rootMessage.json.message.channel_id).toBe(channelId);
    expect(rootMessage.json.thread.title).toBe('Typed chat backend');
    expect(rootMessage.json.thread.source_message_id).toBe(rootMessage.json.message.id);
    expect(rootMessage.json.message.thread_id).toBe(rootMessage.json.thread.id);
    expect(rootMessage.json.outbox.row_version).toBeGreaterThan(0);
    expect(rootMessage.json.thread_outbox.row_version).toBeGreaterThan(rootMessage.json.outbox.row_version);
    const threadId = rootMessage.json.thread.id as string;
    const rootMessageId = rootMessage.json.message.id as string;

    const threadReplyBody = 'Reply stays scoped to the same channel thread.';
    const threadReply = await requestJson(messagesPath, 'POST', ownerSecret, {
      body: threadReplyBody,
      thread_id: threadId,
      message_signature: messageSignature({ body: threadReplyBody, secret: ownerSecret, workspaceId, channelId, threadId }),
    });
    expect(threadReply.res.status).toBe(201);
    expect(threadReply.json.message.thread_id).toBe(threadId);

    const ownerMessages = await requestJson(messagesPath, 'GET', ownerSecret);
    expect(ownerMessages.res.status).toBe(200);
    expectFixtureRequiredKeys(ownerMessages.json, 'channel-messages-list.json');
    expect(ownerMessages.json.messages.map((message: any) => message.id)).toEqual(
      expect.arrayContaining([rootMessageId, threadReply.json.message.id]),
    );

    const memberMessages = await requestJson(`${messagesPath}?thread_id=${threadId}`, 'GET', memberSecret);
    expect(memberMessages.res.status).toBe(200);
    expect(memberMessages.json.messages.map((message: any) => message.id)).toEqual(
      expect.arrayContaining([rootMessageId, threadReply.json.message.id]),
    );

    const memberThreads = await requestJson(threadsPath, 'GET', memberSecret);
    expect(memberThreads.res.status).toBe(200);
    expectFixtureRequiredKeys(memberThreads.json, 'channel-threads-list.json');
    expect(memberThreads.json.threads.map((thread: any) => thread.id)).toContain(threadId);

    const archiveThread = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/threads/${threadId}/archive`, 'PATCH', ownerSecret, {
      archived: true,
      row_version: memberThreads.json.threads.find((thread: any) => thread.id === threadId).row_version,
    });
    expect(archiveThread.res.status).toBe(200);
    expect(archiveThread.json.thread.id).toBe(threadId);
    expect(archiveThread.json.thread.record_state).toBe('archived');
    expect(archiveThread.json.audit.operation).toBe('thread.archive');

    const activeThreadsAfterArchive = await requestJson(threadsPath, 'GET', memberSecret);
    expect(activeThreadsAfterArchive.res.status).toBe(200);
    expect(activeThreadsAfterArchive.json.threads.map((thread: any) => thread.id)).not.toContain(threadId);

    const archivedThreads = await requestJson(`${threadsPath}?include_archived=true`, 'GET', memberSecret);
    expect(archivedThreads.res.status).toBe(200);
    expect(archivedThreads.json.threads.map((thread: any) => thread.id)).toContain(threadId);

    const replyAfterArchiveBody = 'Reply reopens archived implementation work.';
    const replyAfterArchive = await requestJson(messagesPath, 'POST', ownerSecret, {
      body: replyAfterArchiveBody,
      thread_id: threadId,
      message_signature: messageSignature({ body: replyAfterArchiveBody, secret: ownerSecret, workspaceId, channelId, threadId }),
    });
    expect(replyAfterArchive.res.status).toBe(201);
    expect(replyAfterArchive.json.thread.record_state).toBe('active');
    expect(replyAfterArchive.json.thread_operation).toBe('thread.update');

    const activeThreadsAfterReply = await requestJson(threadsPath, 'GET', memberSecret);
    expect(activeThreadsAfterReply.res.status).toBe(200);
    expect(activeThreadsAfterReply.json.threads.map((thread: any) => thread.id)).toContain(threadId);

    const siblingMessagesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${siblingChannelId}/messages`;
    const siblingMessageBody = 'Sibling hidden message';
    const siblingMessageCreate = await requestJson(siblingMessagesPath, 'POST', ownerSecret, {
      body: siblingMessageBody,
      message_signature: messageSignature({ body: siblingMessageBody, secret: ownerSecret, workspaceId, channelId: siblingChannelId }),
    });
    expect(siblingMessageCreate.res.status).toBe(201);
    const siblingMessageId = siblingMessageCreate.json.message.id as string;

    const memberSiblingMessages = await requestJson(siblingMessagesPath, 'GET', memberSecret);
    expect(memberSiblingMessages.res.status).toBe(403);
    expect(memberSiblingMessages.json.required_permission).toBe('channel.read');

    const docsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/docs`;
    const siblingDocsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${siblingChannelId}/docs`;
    const [workspaceOwner] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${workspaceId}
      LIMIT 1
    `;
    const [docStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'launch-brief.md',
        'text/markdown',
        4096,
        'v4/flightdeck-pg/api/launch-brief.md'
      )
      RETURNING id
    `;

    const memberDeniedDocCreate = await requestJson(docsPath, 'POST', memberSecret, {
      title: 'Denied doc',
      storage_object_id: docStorageObject.id,
    });
    expect(memberDeniedDocCreate.res.status).toBe(403);
    expect(memberDeniedDocCreate.json.required_permission).toBe('doc.write or channel.write');

    const docCreate = await requestJson(docsPath, 'POST', ownerSecret, {
      title: 'Launch brief',
      summary: 'Daily launch plan',
      storage_object_id: docStorageObject.id,
      metadata: { source: 'test' },
    });
    expect(docCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(docCreate.json, 'channel-docs-create.json');
    expect(docCreate.json.doc.title).toBe('Launch brief');
    expect(docCreate.json.doc.storage_object_id).toBe(docStorageObject.id);
    expect(docCreate.json.doc.body.object_id).toBe(docStorageObject.id);
    expect(JSON.stringify(docCreate.json).toLowerCase()).not.toContain('storage_path');
    const docId = docCreate.json.doc.id as string;

    const ownerDocs = await requestJson(docsPath, 'GET', ownerSecret);
    expect(ownerDocs.res.status).toBe(200);
    expectFixtureRequiredKeys(ownerDocs.json, 'channel-docs-list.json');
    expect(ownerDocs.json.docs.map((doc: any) => doc.id)).toContain(docId);

    const memberDocs = await requestJson(docsPath, 'GET', memberSecret);
    expect(memberDocs.res.status).toBe(200);
    expect(memberDocs.json.docs.map((doc: any) => doc.id)).toContain(docId);

    const docRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}`, 'GET', memberSecret);
    expect(docRead.res.status).toBe(200);
    expectFixtureRequiredKeys(docRead.json, 'docs-read.json');
    expect(docRead.json.doc.body.storage_object.object_id).toBe(docStorageObject.id);
    expect(JSON.stringify(docRead.json).toLowerCase()).not.toContain('storage_path');

    const docPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}`;
    const archiveOnlyDocUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      row_version: docCreate.json.doc.row_version,
      archived: true,
    });
    expect(archiveOnlyDocUpdate.res.status).toBe(200);
    expect(archiveOnlyDocUpdate.json.doc.archived_at).toBeTruthy();
    expect(archiveOnlyDocUpdate.json.doc.record_state).toBe('archived');

    const restoreOnlyDocUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      row_version: archiveOnlyDocUpdate.json.doc.row_version,
      archived: false,
    });
    expect(restoreOnlyDocUpdate.res.status).toBe(200);
    expect(restoreOnlyDocUpdate.json.doc.archived_at).toBeNull();
    expect(restoreOnlyDocUpdate.json.doc.record_state).toBe('active');

    const missingDocLeaseUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      title: 'Launch brief without lease',
      row_version: restoreOnlyDocUpdate.json.doc.row_version,
    });
    expect(missingDocLeaseUpdate.res.status).toBe(400);
    expect(missingDocLeaseUpdate.json.code).toBe('validation_error');
    expect(missingDocLeaseUpdate.json.details.fields).toContainEqual(expect.objectContaining({ path: 'lease_token', code: 'required' }));

    const memberNoWriteDocLease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', memberSecret, {
      entity_type: 'document',
      entity_id: docId,
    });
    expect(memberNoWriteDocLease.res.status).toBe(403);
    expect(memberNoWriteDocLease.json.required_permission).toBe('doc.write or channel.write');

    const ownerDocLease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', ownerSecret, {
      entity_type: 'document',
      entity_id: docId,
    });
    expect(ownerDocLease.res.status).toBe(201);
    expect(ownerDocLease.json.lease.lease_token).toBeTruthy();

    const missingDocRowVersionUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      title: 'Launch brief without row version',
      lease_token: ownerDocLease.json.lease.lease_token,
    });
    expect(missingDocRowVersionUpdate.res.status).toBe(400);
    expect(missingDocRowVersionUpdate.json.code).toBe('validation_error');
    expect(missingDocRowVersionUpdate.json.details.fields).toContainEqual(expect.objectContaining({ path: 'row_version', code: 'required' }));

    const invalidDocLeaseUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      title: 'Launch brief invalid lease',
      row_version: docCreate.json.doc.row_version,
      lease_token: 'not-the-lease',
    });
    expect(invalidDocLeaseUpdate.res.status).toBe(409);
    expect(invalidDocLeaseUpdate.json.code).toBe('lease_invalid');

    const validDocUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      title: 'Launch brief revised',
      summary: null,
      row_version: restoreOnlyDocUpdate.json.doc.row_version,
      lease_token: ownerDocLease.json.lease.lease_token,
      metadata: { source: 'test', edited: true },
    });
    expect(validDocUpdate.res.status).toBe(200);
    expect(validDocUpdate.json.doc.title).toBe('Launch brief revised');
    expect(validDocUpdate.json.doc.summary).toBeNull();
    expect(validDocUpdate.json.doc.row_version).toBe(4);
    expect(validDocUpdate.json.outbox.row_version).toBeGreaterThan(0);

    const staleDocUpdate = await requestJson(docPath, 'PATCH', ownerSecret, {
      title: 'Launch brief stale',
      row_version: restoreOnlyDocUpdate.json.doc.row_version,
      lease_token: ownerDocLease.json.lease.lease_token,
    });
    expect(staleDocUpdate.res.status).toBe(409);
    expect(staleDocUpdate.json.code).toBe('stale_row_version');

    const [storedDocUpdate] = await sql<{ title: string; summary: string | null; row_version: number }[]>`
      SELECT title, summary, row_version
      FROM flightdeck_pg_docs
      WHERE id = ${docId}
    `;
    expect(storedDocUpdate).toEqual({ title: 'Launch brief revised', summary: null, row_version: 4 });

    const docBodyPending = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/body`, 'GET', memberSecret);
    expect(docBodyPending.res.status).toBe(409);
    expect(docBodyPending.json.code).toBe('doc_body_upload_incomplete');
    expect(docBodyPending.json.doc.body.storage_object.object_id).toBe(docStorageObject.id);

    const docBytes = Buffer.from('# Launch brief\n\nOn schedule.\n', 'utf8');
    const writtenDocBody = await writeStorageObject(docStorageObject.id, docBytes, OWNER_NPUB);
    expect(writtenDocBody?.id).toBe(docStorageObject.id);
    const completedDocBody = await completeStorageObject(docStorageObject.id, {
      sha256_hex: sha256Hex(docBytes),
      size_bytes: docBytes.byteLength,
    }, OWNER_NPUB);
    expect(completedDocBody?.completed_at).toBeTruthy();

    const docBodyRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/body`, 'GET', memberSecret);
    expect(docBodyRead.res.status).toBe(200);
    expectFixtureRequiredKeys(docBodyRead.json, 'docs-body-read.json');
    expect(docBodyRead.json.identity.workspace_id).toBe(workspaceId);
    expect(docBodyRead.json.doc.id).toBe(docId);
    expect(docBodyRead.json.doc.body.storage_object.object_id).toBe(docStorageObject.id);
    expect(docBodyRead.json.doc.body.storage_object.content_type).toBe('text/markdown');
    expect(docBodyRead.json.doc.body.storage_object.size_bytes).toBe(docBytes.byteLength);
    expect(docBodyRead.json.doc.body.storage_object.sha256_hex).toBe(sha256Hex(docBytes));
    expect(docBodyRead.json.body.object_id).toBe(docStorageObject.id);
    expect(docBodyRead.json.body.content_type).toBe('text/markdown');
    expect(docBodyRead.json.body.size_bytes).toBe(docBytes.byteLength);
    expect(docBodyRead.json.body.sha256_hex).toBe(sha256Hex(docBytes));
    expect(docBodyRead.json.body.encoding).toBe('base64');
    expect(docBodyRead.json.body.base64_data).toBe(Buffer.from(docBytes).toString('base64'));
    const docVersions = await requestJson(`${docPath}/versions`, 'GET', memberSecret);
    expect(docVersions.res.status).toBe(200);
    expect(docVersions.json.versions.map((version: any) => version.version)).toEqual([4, 3, 2, 1]);
    expect(docVersions.json.versions[0].title).toBe('Launch brief revised');
    expect(docVersions.json.versions[0].content.content).toContain('Launch brief');
    expect(docVersions.json.versions[0].content.raw).toBeDefined();
    const docBodyReadPayload = JSON.stringify(docBodyRead.json).toLowerCase();
    expect(docBodyReadPayload).not.toContain('storage_path');
    expect(docBodyReadPayload).not.toContain('credential');
    expect(docBodyReadPayload).not.toContain('secret_access_key');
    expect(docBodyReadPayload).not.toContain('bearer');
    expect(docBodyReadPayload).not.toContain('token');

    const mentionCursorPage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=200`, 'GET', ownerSecret);
    const mentionStartCursor = mentionCursorPage.json.next_cursor;
    const saveDocMentions = async (rowVersion: number, mentions: any[]) => {
      const lease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', ownerSecret, {
        entity_type: 'document',
        entity_id: docId,
      });
      expect(lease.res.status).toBe(201);
      return requestJson(docPath, 'PATCH', ownerSecret, {
        row_version: rowVersion,
        lease_token: lease.json.lease.lease_token,
        mentions,
      });
    };
    const agentMention = { type: 'agent', npub: AGENT_NPUB, label: 'Document agent' };
    const firstMentionSave = await saveDocMentions(validDocUpdate.json.doc.row_version, [agentMention]);
    expect(firstMentionSave.res.status).toBe(200);
    expect(firstMentionSave.json.doc.metadata.mentions).toEqual([expect.objectContaining({ type: 'agent', npub: AGENT_NPUB, actor_id: expect.any(String) })]);
    expect(firstMentionSave.json.mention_outbox).toEqual(expect.objectContaining({ id: expect.any(String), row_version: expect.any(Number) }));

    const unchangedMentionSave = await saveDocMentions(firstMentionSave.json.doc.row_version, [agentMention]);
    expect(unchangedMentionSave.res.status).toBe(200);
    expect(unchangedMentionSave.json.mention_outbox).toBeNull();
    const removedMentionSave = await saveDocMentions(unchangedMentionSave.json.doc.row_version, []);
    expect(removedMentionSave.json.mention_outbox).toBeNull();
    const readdedMentionSave = await saveDocMentions(removedMentionSave.json.doc.row_version, [agentMention]);
    expect(readdedMentionSave.json.mention_outbox).toEqual(expect.objectContaining({ id: expect.any(String) }));
    const inaccessibleMentionSave = await saveDocMentions(readdedMentionSave.json.doc.row_version, [{ type: 'agent', npub: INACCESSIBLE_AGENT_NPUB }]);
    expect(inaccessibleMentionSave.res.status).toBe(400);
    expect(inaccessibleMentionSave.json.details.fields).toContainEqual(expect.objectContaining({ code: 'inaccessible_actor' }));

    const mentionEvents = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?cursor=${encodeURIComponent(mentionStartCursor)}&limit=200`, 'GET', ownerSecret);
    const documentMentionEvents = mentionEvents.json.events.filter((event: any) => event.event_type === 'flightdeck_pg.document_mention_added' && event.entity_id === docId);
    expect(documentMentionEvents).toHaveLength(2);
    expect(documentMentionEvents[0].payload).toMatchObject({ trigger: 'document_mention_added', document_id: docId, added_mentions: [expect.objectContaining({ npub: AGENT_NPUB })], author: { actor_npub: OWNER_NPUB, signer_npub: OWNER_NPUB } });
    const replayMentionEvents = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?cursor=${encodeURIComponent(documentMentionEvents[0].cursor)}`, 'GET', ownerSecret);
    expect(replayMentionEvents.json.events.filter((event: any) => event.event_type === 'flightdeck_pg.document_mention_added' && event.entity_id === docId)).toHaveLength(1);

    const docCommentsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/comments`;
    const docCommentCreate = await requestJson(docCommentsPath, 'POST', ownerSecret, {
      body: 'Please expand the rollout section.',
      mentions: [agentMention],
      metadata: { source: 'test' },
    });
    expect(docCommentCreate.res.status).toBe(201);
    expect(docCommentCreate.json.comment.doc_id).toBe(docId);
    expect(docCommentCreate.json.comment.body).toBe('Please expand the rollout section.');
    expect(docCommentCreate.json.comment.metadata.mentions).toEqual([expect.objectContaining({ npub: AGENT_NPUB })]);
    expect(docCommentCreate.json.mention_outbox).toEqual(expect.objectContaining({ id: expect.any(String) }));

    const docCommentReply = await requestJson(docCommentsPath, 'POST', ownerSecret, {
      parent_comment_id: docCommentCreate.json.comment.id,
      body: 'Expanded in the revision.',
    });
    expect(docCommentReply.res.status).toBe(201);
    expect(docCommentReply.json.comment.parent_comment_id).toBe(docCommentCreate.json.comment.id);

    const deniedDocCommentMention = await requestJson(docCommentsPath, 'POST', ownerSecret, {
      body: 'This target cannot read the document.',
      mentions: [{ type: 'agent', npub: INACCESSIBLE_AGENT_NPUB }],
    });
    expect(deniedDocCommentMention.res.status).toBe(400);
    expect(deniedDocCommentMention.json.details.fields).toContainEqual(expect.objectContaining({ code: 'inaccessible_actor' }));

    const reviewRequest = {
      scope_id: docCreate.json.doc.scope_id,
      channel_id: docCreate.json.doc.channel_id,
      prompt: 'Please review this document and its comments.',
      trigger: 'full_document_review_requested',
      client_request_id: `document-review:${docId}:1`,
      recipients: [{ type: 'agent', npub: AGENT_NPUB }],
      targets: [{ type: 'document', id: docId }],
      metadata: { source_surface: 'document_header_review' },
    };
    const fullReview = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/invocations`, 'POST', ownerSecret, reviewRequest);
    expect(fullReview.res.status).toBe(201);
    expect(fullReview.json).toMatchObject({ replayed: false, trigger_outbox: { id: expect.any(String), row_version: expect.any(Number) }, invocation: { metadata: { trigger: 'full_document_review_requested', client_request_id: reviewRequest.client_request_id } } });
    const fullReviewReplay = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/invocations`, 'POST', ownerSecret, reviewRequest);
    expect(fullReviewReplay.res.status).toBe(200);
    expect(fullReviewReplay.json.replayed).toBe(true);
    expect(fullReviewReplay.json.invocation.id).toBe(fullReview.json.invocation.id);

    const docCommentsList = await requestJson(docCommentsPath, 'GET', memberSecret);
    expect(docCommentsList.res.status).toBe(200);
    expect(docCommentsList.json.comments.map((comment: any) => comment.id)).toContain(docCommentCreate.json.comment.id);
    expect(docCommentsList.json.comments.map((comment: any) => comment.id)).toContain(docCommentReply.json.comment.id);

    const docCommentUpdate = await requestJson(`${docCommentsPath}/${docCommentCreate.json.comment.id}`, 'PATCH', ownerSecret, {
      comment_status: 'resolved',
      row_version: docCommentCreate.json.comment.row_version,
    });
    expect(docCommentUpdate.res.status).toBe(200);
    expect(docCommentUpdate.json.comment.metadata.comment_status).toBe('resolved');
    expect(docCommentUpdate.json.audit.operation).toBe('doc_comment.update');

    const docCommentDelete = await requestJson(`${docCommentsPath}/${docCommentCreate.json.comment.id}?row_version=${docCommentUpdate.json.comment.row_version}`, 'DELETE', ownerSecret);
    expect(docCommentDelete.res.status).toBe(200);
    expect(docCommentDelete.json.comment.record_state).toBe('deleted');
    expect(docCommentDelete.json.audit.operation).toBe('doc_comment.delete');

    const docCommentsAfterDelete = await requestJson(docCommentsPath, 'GET', memberSecret);
    expect(docCommentsAfterDelete.res.status).toBe(200);
    expect(docCommentsAfterDelete.json.comments.map((comment: any) => comment.id)).not.toContain(docCommentCreate.json.comment.id);
    expect(docCommentsAfterDelete.json.comments.map((comment: any) => comment.id)).not.toContain(docCommentReply.json.comment.id);

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspaceId}, ${inviteCreate.json.actor.actor_id}, 'guest', ${ownerId})
    `;
    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id,
        principal_type,
        principal_actor_id,
        resource_type,
        resource_channel_id,
        permission,
        created_by_actor_id
      )
      VALUES (${workspaceId}, 'actor', ${inviteCreate.json.actor.actor_id}, 'channel', ${channelId}, 'doc.read', ${ownerId})
    `;
    const docReaderOnly = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}`, 'GET', inviteeSecret);
    expect(docReaderOnly.res.status).toBe(200);
    expect(docReaderOnly.json.doc.id).toBe(docId);

    const [siblingDocStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'sibling-brief.md',
        'text/markdown',
        2048,
        'v4/flightdeck-pg/api/sibling-brief.md'
      )
      RETURNING id
    `;
    const siblingDocCreate = await requestJson(siblingDocsPath, 'POST', ownerSecret, {
      title: 'Sibling hidden doc',
      storage_object_id: siblingDocStorageObject.id,
    });
    expect(siblingDocCreate.res.status).toBe(201);
    const siblingDocId = siblingDocCreate.json.doc.id as string;

    const memberSiblingDocs = await requestJson(siblingDocsPath, 'GET', memberSecret);
    expect(memberSiblingDocs.res.status).toBe(403);
    expect(memberSiblingDocs.json.required_permission).toBe('doc.read or channel.read');

    const memberSiblingDocBody = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${siblingDocId}/body`, 'GET', memberSecret);
    expect(memberSiblingDocBody.res.status).toBe(403);
    expect(memberSiblingDocBody.json.required_permission).toBe('doc.read or channel.read');

    const filesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/files`;
    const siblingFilesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${siblingChannelId}/files`;
    const foldersPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/file-folders`;
    const memberDeniedFolderCreate = await requestJson(foldersPath, 'POST', memberSecret, {
      title: 'Denied folder',
    });
    expect(memberDeniedFolderCreate.res.status).toBe(403);
    expect(memberDeniedFolderCreate.json.required_permission).toBe('file.write or channel.write');

    const folderCreate = await requestJson(foldersPath, 'POST', ownerSecret, {
      title: 'Launch assets',
      metadata: { source: 'test' },
    });
    expect(folderCreate.res.status).toBe(201);
    expect(folderCreate.json.folder.title).toBe('Launch assets');
    const folderId = folderCreate.json.folder.id as string;

    const [fileStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'launch-checklist.txt',
        'text/plain',
        1024,
        'v4/flightdeck-pg/api/launch-checklist.txt'
      )
      RETURNING id
    `;

    const memberDeniedFileCreate = await requestJson(filesPath, 'POST', memberSecret, {
      display_name: 'Denied file',
      storage_object_id: fileStorageObject.id,
    });
    expect(memberDeniedFileCreate.res.status).toBe(403);
    expect(memberDeniedFileCreate.json.required_permission).toBe('file.write or channel.write');

    const fileCreate = await requestJson(filesPath, 'POST', ownerSecret, {
      display_name: 'Launch checklist',
      description: 'Daily launch checklist',
      storage_object_id: fileStorageObject.id,
      folder_id: folderId,
      metadata: { source: 'test' },
    });
    expect(fileCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(fileCreate.json, 'channel-files-create.json');
    expect(fileCreate.json.file.display_name).toBe('Launch checklist');
    expect(fileCreate.json.file.storage_object_id).toBe(fileStorageObject.id);
    expect(fileCreate.json.file.current_version_id).toBeTruthy();
    expect(fileCreate.json.file.current_version).toBeNull();
    expect(fileCreate.json.file.folder_id).toBe(folderId);
    expect(fileCreate.json.file.object.object_id).toBe(fileStorageObject.id);
    expect(JSON.stringify(fileCreate.json).toLowerCase()).not.toContain('storage_path');
    const fileId = fileCreate.json.file.id as string;
    const initialFileVersionId = fileCreate.json.file.current_version_id as string;

    const ownerFiles = await requestJson(filesPath, 'GET', ownerSecret);
    expect(ownerFiles.res.status).toBe(200);
    expectFixtureRequiredKeys(ownerFiles.json, 'channel-files-list.json');
    expect(ownerFiles.json.files.map((file: any) => file.id)).toContain(fileId);

    const memberFiles = await requestJson(filesPath, 'GET', memberSecret);
    expect(memberFiles.res.status).toBe(200);
    expect(memberFiles.json.files.map((file: any) => file.id)).toContain(fileId);

    const driveTreeRoot = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/tree?channel_id=${channelId}&parent_folder_id=&limit=50`, 'GET', memberSecret);
    expect(driveTreeRoot.res.status).toBe(200);
    expectFixtureRequiredKeys(driveTreeRoot.json, 'drive-tree.json');
    expect(driveTreeRoot.json.items.map((item: any) => item.id)).toContain(folderId);
    expect(driveTreeRoot.json.items.map((item: any) => item.id)).not.toContain(fileId);
    expect(driveTreeRoot.json.items.find((item: any) => item.id === folderId).refetch).toBe(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`);

    const driveTreeChildren = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/tree?channel_id=${channelId}&parent_folder_id=${folderId}&limit=50`, 'GET', memberSecret);
    expect(driveTreeChildren.res.status).toBe(200);
    expect(driveTreeChildren.json.items.map((item: any) => item.id)).toContain(fileId);
    expect(driveTreeChildren.json.items.find((item: any) => item.id === fileId)).toEqual(expect.objectContaining({
      type: 'file',
      current_version_id: initialFileVersionId,
      storage_object_id: fileStorageObject.id,
      refetch: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`,
    }));

    const driveDelta = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/delta?channel_id=${channelId}&limit=50`, 'GET', memberSecret);
    expect(driveDelta.res.status).toBe(200);
    expectFixtureRequiredKeys(driveDelta.json, 'drive-delta.json');
    expect(driveDelta.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'folder',
        id: folderId,
        operation: 'created',
        row_version: folderCreate.json.folder.row_version,
        refetch: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`,
      }),
      expect.objectContaining({
        type: 'file',
        id: fileId,
        operation: 'created',
        row_version: fileCreate.json.file.row_version,
        refetch: `/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`,
      }),
    ]));
    expect(driveDelta.json.next_cursor).toBeTruthy();
    expect(driveDelta.json.has_more).toBe(false);

    const fileRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`, 'GET', memberSecret);
    expect(fileRead.res.status).toBe(200);
    expectFixtureRequiredKeys(fileRead.json, 'files-read.json');
    expect(fileRead.json.file.object.storage_object.object_id).toBe(fileStorageObject.id);
    expect(fileRead.json.file.current_version_id).toBe(initialFileVersionId);
    expect(JSON.stringify(fileRead.json).toLowerCase()).not.toContain('storage_path');

    const fileObjectPending = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret);
    expect(fileObjectPending.res.status).toBe(409);
    expect(fileObjectPending.json.code).toBe('file_object_upload_incomplete');
    expect(fileObjectPending.json.file.object.storage_object.object_id).toBe(fileStorageObject.id);

    const fileBytes = Buffer.from('Checklist content', 'utf8');
    const writtenFileObject = await writeStorageObject(fileStorageObject.id, fileBytes, OWNER_NPUB);
    expect(writtenFileObject?.id).toBe(fileStorageObject.id);
    const completedFileObject = await completeStorageObject(fileStorageObject.id, {
      sha256_hex: sha256Hex(fileBytes),
      size_bytes: fileBytes.byteLength,
    }, OWNER_NPUB);
    expect(completedFileObject?.completed_at).toBeTruthy();

    const fileObjectRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret);
    expect(fileObjectRead.res.status).toBe(200);
    expect(fileObjectRead.res.headers.get('accept-ranges')).toBe('bytes');
    expect(fileObjectRead.res.headers.get('etag')).toBe(`"${sha256Hex(fileBytes)}"`);
    expectFixtureRequiredKeys(fileObjectRead.json, 'files-object-read.json');
    expect(fileObjectRead.json.identity.workspace_id).toBe(workspaceId);
    expect(fileObjectRead.json.file.id).toBe(fileId);
    expect(fileObjectRead.json.file.object.storage_object.object_id).toBe(fileStorageObject.id);
    expect(fileObjectRead.json.file.object.storage_object.content_type).toBe('text/plain');
    expect(fileObjectRead.json.file.object.storage_object.size_bytes).toBe(fileBytes.byteLength);
    expect(fileObjectRead.json.file.object.storage_object.sha256_hex).toBe(sha256Hex(fileBytes));
    expect(fileObjectRead.json.object.object_id).toBe(fileStorageObject.id);
    expect(fileObjectRead.json.object.content_type).toBe('text/plain');
    expect(fileObjectRead.json.object.file_name).toBe('launch-checklist.txt');
    expect(fileObjectRead.json.object.size_bytes).toBe(fileBytes.byteLength);
    expect(fileObjectRead.json.object.sha256_hex).toBe(sha256Hex(fileBytes));
    expect(fileObjectRead.json.object.encoding).toBe('base64');
    expect(fileObjectRead.json.object.base64_data).toBe(Buffer.from(fileBytes).toString('base64'));
    const fileObjectPayload = JSON.stringify(fileObjectRead.json).toLowerCase();
    expect(fileObjectPayload).not.toContain('storage_path');
    expect(fileObjectPayload).not.toContain('credential');
    expect(fileObjectPayload).not.toContain('secret_access_key');
    expect(fileObjectPayload).not.toContain('bearer');
    expect(fileObjectPayload).not.toContain('token');

    const fileObjectRange = await requestRaw(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret, {
      Range: 'bytes=0-8',
    });
    expect(fileObjectRange.res.status).toBe(206);
    expect(fileObjectRange.res.headers.get('accept-ranges')).toBe('bytes');
    expect(fileObjectRange.res.headers.get('etag')).toBe(`"${sha256Hex(fileBytes)}"`);
    expect(fileObjectRange.res.headers.get('content-type')).toBe('text/plain');
    expect(fileObjectRange.res.headers.get('content-length')).toBe('9');
    expect(fileObjectRange.res.headers.get('content-range')).toBe(`bytes 0-8/${fileBytes.byteLength}`);
    expect(Buffer.from(fileObjectRange.bytes).toString('utf8')).toBe('Checklist');

    const fileObjectSuffixRange = await requestRaw(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret, {
      Range: 'bytes=-7',
    });
    expect(fileObjectSuffixRange.res.status).toBe(206);
    expect(fileObjectSuffixRange.res.headers.get('content-range')).toBe(`bytes ${fileBytes.byteLength - 7}-${fileBytes.byteLength - 1}/${fileBytes.byteLength}`);
    expect(Buffer.from(fileObjectSuffixRange.bytes).toString('utf8')).toBe('content');

    const fileObjectUnsatisfiableRange = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret, undefined, {
      Range: `bytes=${fileBytes.byteLength}-`,
    });
    expect(fileObjectUnsatisfiableRange.res.status).toBe(416);
    expect(fileObjectUnsatisfiableRange.res.headers.get('accept-ranges')).toBe('bytes');
    expect(fileObjectUnsatisfiableRange.res.headers.get('etag')).toBe(`"${sha256Hex(fileBytes)}"`);
    expect(fileObjectUnsatisfiableRange.res.headers.get('content-range')).toBe(`bytes */${fileBytes.byteLength}`);
    expect(fileObjectUnsatisfiableRange.json.code).toBe('range_not_satisfiable');
    expect(fileObjectUnsatisfiableRange.json.size_bytes).toBe(fileBytes.byteLength);

    const [replacementFileStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'launch-checklist-v2.txt',
        'text/plain',
        2048,
        'v4/flightdeck-pg/api/launch-checklist-v2.txt'
      )
      RETURNING id
    `;
    const replacementBytes = Buffer.from('Updated checklist content', 'utf8');
    await writeStorageObject(replacementFileStorageObject.id, replacementBytes, OWNER_NPUB);
    await completeStorageObject(replacementFileStorageObject.id, {
      sha256_hex: sha256Hex(replacementBytes),
      size_bytes: replacementBytes.byteLength,
    }, OWNER_NPUB);

    const fileVersionCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/versions`, 'POST', ownerSecret, {
      base_version_id: initialFileVersionId,
      storage_object_id: replacementFileStorageObject.id,
      client_mutation_id: 'replace-checklist-v2',
    });
    expect(fileVersionCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(fileVersionCreate.json, 'files-versions-create.json');
    expect(fileVersionCreate.json.file.id).toBe(fileId);
    expect(fileVersionCreate.json.file.storage_object_id).toBe(replacementFileStorageObject.id);
    expect(fileVersionCreate.json.file.current_version_id).toBe(fileVersionCreate.json.version.id);
    expect(fileVersionCreate.json.file.row_version).toBe(fileCreate.json.file.row_version + 1);
    expect(fileVersionCreate.json.version.version_number).toBe(2);
    expect(fileVersionCreate.json.version.base_version_id).toBe(initialFileVersionId);
    expect(fileVersionCreate.json.version.operation).toBe('replaced');
    expect(fileVersionCreate.json.version.storage_object_id).toBe(replacementFileStorageObject.id);
    expect(fileVersionCreate.json.version.sha256_hex).toBe(sha256Hex(replacementBytes));
    expect(fileVersionCreate.json.version.etag).toBe(`"${sha256Hex(replacementBytes)}"`);
    expect(fileVersionCreate.json.storage_link.storage_object_id).toBe(replacementFileStorageObject.id);
    const replacementVersionId = fileVersionCreate.json.version.id as string;

    const fileVersionList = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/versions?limit=1`,
      'GET',
      memberSecret,
    );
    expect(fileVersionList.res.status).toBe(200);
    expectFixtureRequiredKeys(fileVersionList.json, 'files-versions-list.json');
    expect(fileVersionList.json.file_id).toBe(fileId);
    expect(fileVersionList.json.current_version_id).toBe(replacementVersionId);
    expect(fileVersionList.json.next_cursor).toBeNull();
    expect(fileVersionList.json.versions).toHaveLength(1);
    expect(fileVersionList.json.versions[0]).toEqual(expect.objectContaining({
      id: replacementVersionId,
      version_number: 2,
      storage_object_id: replacementFileStorageObject.id,
      size_bytes: replacementBytes.byteLength,
      content_type: 'text/plain',
      sha256_hex: sha256Hex(replacementBytes),
      etag: `"${sha256Hex(replacementBytes)}"`,
      base_version_id: initialFileVersionId,
      operation: 'replaced',
      created_by_actor_id: ownerId,
      created_by_actor_npub: OWNER_NPUB,
    }));

    const [staleFileStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'launch-checklist-stale.txt',
        'text/plain',
        4096,
        'v4/flightdeck-pg/api/launch-checklist-stale.txt'
      )
      RETURNING id
    `;
    const staleVersionCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/versions`, 'POST', ownerSecret, {
      base_version_id: initialFileVersionId,
      storage_object_id: staleFileStorageObject.id,
      client_mutation_id: 'replace-checklist-stale',
    });
    expect(staleVersionCreate.res.status).toBe(409);
    expect(staleVersionCreate.json.code).toBe('stale_base_version');
    expect(staleVersionCreate.json.file.id).toBe(fileId);
    expect(staleVersionCreate.json.file.current_version_id).toBe(replacementVersionId);
    expect(staleVersionCreate.json.current_version.id).toBe(replacementVersionId);
    expect(staleVersionCreate.json.current_version.storage_object_id).toBe(replacementFileStorageObject.id);
    expect(staleVersionCreate.json.current_version.base_version_id).toBe(initialFileVersionId);

    const missingBaseVersionCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/versions`, 'POST', ownerSecret, {
      storage_object_id: staleFileStorageObject.id,
    });
    expect(missingBaseVersionCreate.res.status).toBe(400);
    expect(missingBaseVersionCreate.json.code).toBe('validation_error');
    expect(missingBaseVersionCreate.json.details.fields).toContainEqual(expect.objectContaining({ path: 'base_version_id', code: 'required' }));

    const replacedFileObjectRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret);
    expect(replacedFileObjectRead.res.status).toBe(200);
    expect(replacedFileObjectRead.json.file.storage_object_id).toBe(replacementFileStorageObject.id);
    expect(replacedFileObjectRead.json.file.current_version_id).toBe(replacementVersionId);
    expect(replacedFileObjectRead.json.object.object_id).toBe(replacementFileStorageObject.id);
    expect(replacedFileObjectRead.json.object.base64_data).toBe(Buffer.from(replacementBytes).toString('base64'));

    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id,
        principal_type,
        principal_actor_id,
        resource_type,
        resource_channel_id,
        permission,
        created_by_actor_id
      )
      VALUES (${workspaceId}, 'actor', ${inviteCreate.json.actor.actor_id}, 'channel', ${channelId}, 'file.read', ${ownerId})
    `;
    const fileReaderOnly = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`, 'GET', inviteeSecret);
    expect(fileReaderOnly.res.status).toBe(200);
    expect(fileReaderOnly.json.file.id).toBe(fileId);

    const readerDeniedFileDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`, 'DELETE', inviteeSecret, {
      row_version: fileVersionCreate.json.file.row_version,
    });
    expect(readerDeniedFileDelete.res.status).toBe(403);
    expect(readerDeniedFileDelete.json.required_permission).toBe('file.write or channel.write');

    const folderNotEmpty = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`, 'DELETE', ownerSecret, {
      row_version: folderCreate.json.folder.row_version,
      mode: 'empty-only',
      client_mutation_id: 'delete-non-empty-folder',
    });
    expect(folderNotEmpty.res.status).toBe(409);
    expect(folderNotEmpty.json.code).toBe('folder_not_empty');
    expect(folderNotEmpty.json.active_file_count).toBe(1);
    expect(folderNotEmpty.json.active_folder_count).toBe(0);

    const staleFileDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`, 'DELETE', ownerSecret, {
      row_version: fileCreate.json.file.row_version,
      client_mutation_id: 'delete-stale-file',
    });
    expect(staleFileDelete.res.status).toBe(409);
    expect(staleFileDelete.json.code).toBe('stale_row_version');
    expect(staleFileDelete.json.file.id).toBe(fileId);
    expect(staleFileDelete.json.current_version.id).toBe(replacementVersionId);

    const fileDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`, 'DELETE', ownerSecret, {
      row_version: fileVersionCreate.json.file.row_version,
      client_mutation_id: 'delete-checklist',
    });
    expect(fileDelete.res.status).toBe(200);
    expectFixtureRequiredKeys(fileDelete.json, 'files-delete.json');
    expect(fileDelete.json.file.id).toBe(fileId);
    expect(fileDelete.json.file.deleted_at).toBeTruthy();
    expect(fileDelete.json.file.deleted_by_actor_id).toBe(ownerId);
    expect(fileDelete.json.file.row_version).toBe(fileVersionCreate.json.file.row_version + 1);
    expect(fileDelete.json.version.operation).toBe('deleted');
    expect(fileDelete.json.version.base_version_id).toBe(replacementVersionId);
    expect(fileDelete.json.version.version_number).toBe(3);
    expect(fileDelete.json.tombstone).toEqual(expect.objectContaining({
      entity_type: 'file',
      entity_id: fileId,
      parent_folder_id: folderId,
      name: 'Launch checklist',
      row_version: fileDelete.json.file.row_version,
      deleted_by_actor_id: ownerId,
      file_version_id: fileDelete.json.version.id,
      client_mutation_id: 'delete-checklist',
    }));
    expect(fileDelete.json.storage_links_tombstoned).toBeGreaterThanOrEqual(1);
    expect(fileDelete.json.outbox.row_version).toBeGreaterThan(0);

    const [fileAudit] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_audit_events
      WHERE workspace_id = ${workspaceId}
        AND action = 'file.delete'
        AND resource_id = ${fileId}
    `;
    expect(Number(fileAudit.count)).toBe(1);

    const fileVersions = await sql<{ operation: string; version_number: number }[]>`
      SELECT operation, version_number
      FROM flightdeck_pg_file_versions
      WHERE workspace_id = ${workspaceId}
        AND file_id = ${fileId}
      ORDER BY version_number ASC
    `;
    expect(fileVersions.map((version) => version.operation)).toEqual(['created', 'replaced', 'deleted']);

    const deletedFileVersionList = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/versions`,
      'GET',
      memberSecret,
    );
    expect(deletedFileVersionList.res.status).toBe(200);
    expect(deletedFileVersionList.json.current_version_id).toBe(fileDelete.json.version.id);
    expect(deletedFileVersionList.json.versions.map((version: any) => version.operation)).toEqual([
      'deleted',
      'replaced',
      'created',
    ]);
    expect(deletedFileVersionList.json.versions.every((version: any) => (
      version.storage_object_id
      && version.size_bytes >= 0
      && version.sha256_hex
      && version.created_by_actor_id === ownerId
      && version.created_by_actor_npub === OWNER_NPUB
    ))).toBe(true);

    const deletedFileRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}`, 'GET', memberSecret);
    expect(deletedFileRead.res.status).toBe(404);
    expect(deletedFileRead.json.code).toBe('file_not_found');

    const deletedFileObjectRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${fileId}/object`, 'GET', memberSecret);
    expect(deletedFileObjectRead.res.status).toBe(404);
    expect(deletedFileObjectRead.json.code).toBe('file_not_found');

    const filesAfterDelete = await requestJson(filesPath, 'GET', memberSecret);
    expect(filesAfterDelete.res.status).toBe(200);
    expect(filesAfterDelete.json.files.map((file: any) => file.id)).not.toContain(fileId);

    const driveTreeAfterFileDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/tree?channel_id=${channelId}&parent_folder_id=${folderId}&limit=50`, 'GET', memberSecret);
    expect(driveTreeAfterFileDelete.res.status).toBe(200);
    expect(driveTreeAfterFileDelete.json.items.map((item: any) => item.id)).not.toContain(fileId);

    const driveDeltaAfterFileDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/delta?channel_id=${channelId}&limit=100`, 'GET', memberSecret);
    expect(driveDeltaAfterFileDelete.res.status).toBe(200);
    expect(driveDeltaAfterFileDelete.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'file',
        id: fileId,
        operation: 'deleted',
        row_version: fileDelete.json.file.row_version,
        tombstone: expect.objectContaining({
          entity_type: 'file',
          entity_id: fileId,
          deleted_by_actor_id: ownerId,
          file_version_id: fileDelete.json.version.id,
        }),
      }),
    ]));

    const folderRename = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`, 'PATCH', ownerSecret, {
      row_version: folderCreate.json.folder.row_version,
      title: 'Launch assets archived',
    });
    expect(folderRename.res.status).toBe(200);

    const staleFolderDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`, 'DELETE', ownerSecret, {
      row_version: folderCreate.json.folder.row_version,
      mode: 'empty-only',
      client_mutation_id: 'delete-stale-folder',
    });
    expect(staleFolderDelete.res.status).toBe(409);
    expect(staleFolderDelete.json.code).toBe('stale_row_version');

    const readerDeniedFolderDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`, 'DELETE', inviteeSecret, {
      row_version: folderRename.json.folder.row_version,
      mode: 'empty-only',
    });
    expect(readerDeniedFolderDelete.res.status).toBe(403);
    expect(readerDeniedFolderDelete.json.required_permission).toBe('file.write or channel.write');

    const folderDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`, 'DELETE', ownerSecret, {
      row_version: folderRename.json.folder.row_version,
      mode: 'empty-only',
      client_mutation_id: 'delete-folder',
    });
    expect(folderDelete.res.status).toBe(200);
    expectFixtureRequiredKeys(folderDelete.json, 'file-folders-delete.json');
    expect(folderDelete.json.folder.id).toBe(folderId);
    expect(folderDelete.json.folder.deleted_at).toBeTruthy();
    expect(folderDelete.json.folder.deleted_by_actor_id).toBe(ownerId);
    expect(folderDelete.json.tombstone).toEqual(expect.objectContaining({
      entity_type: 'folder',
      entity_id: folderId,
      parent_folder_id: null,
      name: 'Launch assets archived',
      row_version: folderDelete.json.folder.row_version,
      deleted_by_actor_id: ownerId,
      client_mutation_id: 'delete-folder',
    }));

    const deletedFolderRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/file-folders/${folderId}`, 'GET', memberSecret);
    expect(deletedFolderRead.res.status).toBe(404);
    expect(deletedFolderRead.json.code).toBe('folder_not_found');

    const foldersAfterDelete = await requestJson(foldersPath, 'GET', memberSecret);
    expect(foldersAfterDelete.res.status).toBe(200);
    expect(foldersAfterDelete.json.folders.map((folder: any) => folder.id)).not.toContain(folderId);

    const driveDeltaAfterFolderDelete = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/delta?channel_id=${channelId}&limit=100`, 'GET', memberSecret);
    expect(driveDeltaAfterFolderDelete.res.status).toBe(200);
    expect(driveDeltaAfterFolderDelete.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'folder',
        id: folderId,
        operation: 'deleted',
        row_version: folderDelete.json.folder.row_version,
        tombstone: expect.objectContaining({
          entity_type: 'folder',
          entity_id: folderId,
          deleted_by_actor_id: ownerId,
          name: 'Launch assets archived',
        }),
      }),
    ]));

    const [siblingFileStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'sibling-file.txt',
        'text/plain',
        2048,
        'v4/flightdeck-pg/api/sibling-file.txt'
      )
      RETURNING id
    `;
    const siblingFileCreate = await requestJson(siblingFilesPath, 'POST', ownerSecret, {
      display_name: 'Sibling hidden file',
      storage_object_id: siblingFileStorageObject.id,
    });
    expect(siblingFileCreate.res.status).toBe(201);
    const siblingFileId = siblingFileCreate.json.file.id as string;

    const memberSiblingFiles = await requestJson(siblingFilesPath, 'GET', memberSecret);
    expect(memberSiblingFiles.res.status).toBe(403);
    expect(memberSiblingFiles.json.required_permission).toBe('file.read or channel.read');

    const memberSiblingDriveTree = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/tree?channel_id=${siblingChannelId}`, 'GET', memberSecret);
    expect(memberSiblingDriveTree.res.status).toBe(403);
    expect(memberSiblingDriveTree.json.required_permission).toBe('file.read or channel.read');

    const memberSiblingDriveDelta = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/drive/delta?channel_id=${siblingChannelId}`, 'GET', memberSecret);
    expect(memberSiblingDriveDelta.res.status).toBe(403);
    expect(memberSiblingDriveDelta.json.required_permission).toBe('file.read or channel.read');

    const memberSiblingFileObject = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${siblingFileId}/object`, 'GET', memberSecret);
    expect(memberSiblingFileObject.res.status).toBe(403);
    expect(memberSiblingFileObject.json.required_permission).toBe('file.read or channel.read');

    const memberSiblingFileObjectRange = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${siblingFileId}/object`, 'GET', memberSecret, undefined, {
      Range: 'bytes=0-1',
    });
    expect(memberSiblingFileObjectRange.res.status).toBe(403);
    expect(memberSiblingFileObjectRange.json.required_permission).toBe('file.read or channel.read');

    const audioNotesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/audio-notes`;
    const siblingAudioNotesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${siblingChannelId}/audio-notes`;
    const [audioStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'standup-note.webm',
        'audio/webm;codecs=opus',
        1536,
        'v4/flightdeck-pg/api/standup-note.webm'
      )
      RETURNING id
    `;

    const memberDeniedAudioCreate = await requestJson(audioNotesPath, 'POST', memberSecret, {
      title: 'Denied audio note',
      storage_object_id: audioStorageObject.id,
      mime_type: 'audio/webm;codecs=opus',
      size_bytes: 1536,
    });
    expect(memberDeniedAudioCreate.res.status).toBe(403);
    expect(memberDeniedAudioCreate.json.required_permission).toBe('audio_note.write or channel.write');

    const audioCreate = await requestJson(audioNotesPath, 'POST', ownerSecret, {
      title: 'Daily standup audio',
      storage_object_id: audioStorageObject.id,
      target_type: 'message',
      target_id: rootMessageId,
      thread_id: threadId,
      mime_type: 'audio/webm;codecs=opus',
      duration_seconds: 8.5,
      size_bytes: 1536,
      media_encryption: { algorithm: 'xchacha20poly1305', key_id: 'audio-key-1' },
      waveform_preview: [0, 0.25, 0.5, 0.25, 0],
      transcript_status: 'pending',
      transcript_preview: 'Daily standup',
      summary: 'Short standup note',
      metadata: { source: 'test' },
      record_state: 'active',
    });
    expect(audioCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(audioCreate.json, 'channel-audio-notes-create.json');
    expect(audioCreate.json.audio_note.storage_object_id).toBe(audioStorageObject.id);
    expect(audioCreate.json.audio_note.thread_id).toBe(threadId);
    expect(audioCreate.json.audio_note.target_type).toBe('message');
    expect(audioCreate.json.audio_note.target_id).toBe(rootMessageId);
    expect(audioCreate.json.audio_note.media_encryption).toEqual({ algorithm: 'xchacha20poly1305', key_id: 'audio-key-1' });
    expect(audioCreate.json.audio_note.waveform_preview).toEqual([0, 0.25, 0.5, 0.25, 0]);
    expect(audioCreate.json.audio_note.transcript_preview).toBe('Daily standup');
    expect(audioCreate.json.audio_note.record_state).toBe('active');
    expect(audioCreate.json.audio_note.media.object_id).toBe(audioStorageObject.id);
    expect(JSON.stringify(audioCreate.json).toLowerCase()).not.toContain('storage_path');
    const audioNoteId = audioCreate.json.audio_note.id as string;

    const badAudioTarget = await requestJson(audioNotesPath, 'POST', ownerSecret, {
      storage_object_id: audioStorageObject.id,
      target_type: 'encrypted_record',
      target_id: rootMessageId,
      mime_type: 'audio/webm;codecs=opus',
      size_bytes: 1,
    });
    expect(badAudioTarget.res.status).toBe(400);
    expect(badAudioTarget.json.code).toBe('validation_error');

    const ownerAudioNotes = await requestJson(audioNotesPath, 'GET', ownerSecret);
    expect(ownerAudioNotes.res.status).toBe(200);
    expectFixtureRequiredKeys(ownerAudioNotes.json, 'channel-audio-notes-list.json');
    expect(ownerAudioNotes.json.audio_notes.map((audioNote: any) => audioNote.id)).toContain(audioNoteId);

    const memberAudioNotes = await requestJson(audioNotesPath, 'GET', memberSecret);
    expect(memberAudioNotes.res.status).toBe(200);
    expect(memberAudioNotes.json.audio_notes.map((audioNote: any) => audioNote.id)).toContain(audioNoteId);
    const listedAudioNote = memberAudioNotes.json.audio_notes.find((audioNote: any) => audioNote.id === audioNoteId);
    expect(listedAudioNote.thread_id).toBe(threadId);
    expect(listedAudioNote.media_encryption).toEqual({ algorithm: 'xchacha20poly1305', key_id: 'audio-key-1' });
    expect(listedAudioNote.waveform_preview).toEqual([0, 0.25, 0.5, 0.25, 0]);
    expect(listedAudioNote.transcript_preview).toBe('Daily standup');
    expect(listedAudioNote.record_state).toBe('active');

    const audioRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/audio-notes/${audioNoteId}`, 'GET', memberSecret);
    expect(audioRead.res.status).toBe(200);
    expectFixtureRequiredKeys(audioRead.json, 'audio-notes-read.json');
    expect(audioRead.json.audio_note.media.storage_object.object_id).toBe(audioStorageObject.id);
    expect(audioRead.json.audio_note.thread_id).toBe(threadId);
    expect(audioRead.json.audio_note.media_encryption).toEqual({ algorithm: 'xchacha20poly1305', key_id: 'audio-key-1' });
    expect(audioRead.json.audio_note.waveform_preview).toEqual([0, 0.25, 0.5, 0.25, 0]);
    expect(audioRead.json.audio_note.transcript_preview).toBe('Daily standup');
    expect(audioRead.json.audio_note.record_state).toBe('active');
    expect(JSON.stringify(audioRead.json).toLowerCase()).not.toContain('storage_path');

    const [audioReplyStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'standup-reply.webm',
        'audio/webm;codecs=opus',
        768,
        'v4/flightdeck-pg/api/standup-reply.webm'
      )
      RETURNING id
    `;
    const audioReplyCreate = await requestJson(audioNotesPath, 'POST', ownerSecret, {
      title: 'Daily standup audio reply',
      storage_object_id: audioReplyStorageObject.id,
      target_type: 'audio_note',
      target_id: audioNoteId,
      mime_type: 'audio/webm;codecs=opus',
      size_bytes: 768,
      transcript_preview: 'Audio note reply',
    });
    expect(audioReplyCreate.res.status).toBe(201);
    expect(audioReplyCreate.json.audio_note.target_type).toBe('audio_note');
    expect(audioReplyCreate.json.audio_note.target_id).toBe(audioNoteId);
    expect(audioReplyCreate.json.audio_note.thread_id).toBe(threadId);
    expect(audioReplyCreate.json.audio_note.transcript_preview).toBe('Audio note reply');

    const audioMediaPending = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/audio-notes/${audioNoteId}/media`, 'GET', memberSecret);
    expect(audioMediaPending.res.status).toBe(409);
    expect(audioMediaPending.json.code).toBe('audio_note_media_upload_incomplete');

    const audioBytes = Buffer.from('audio-note-bytes', 'utf8');
    const writtenAudioMedia = await writeStorageObject(audioStorageObject.id, audioBytes, OWNER_NPUB);
    expect(writtenAudioMedia?.id).toBe(audioStorageObject.id);
    const completedAudioMedia = await completeStorageObject(audioStorageObject.id, {
      sha256_hex: sha256Hex(audioBytes),
      size_bytes: audioBytes.byteLength,
    }, OWNER_NPUB);
    expect(completedAudioMedia?.completed_at).toBeTruthy();

    const audioMediaRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/audio-notes/${audioNoteId}/media`, 'GET', memberSecret);
    expect(audioMediaRead.res.status).toBe(200);
    expectFixtureRequiredKeys(audioMediaRead.json, 'audio-notes-media-read.json');
    expect(audioMediaRead.json.audio_note.media.storage_object.object_id).toBe(audioStorageObject.id);
    expect(audioMediaRead.json.media.object_id).toBe(audioStorageObject.id);
    expect(audioMediaRead.json.media.content_type).toBe('audio/webm;codecs=opus');
    expect(audioMediaRead.json.media.size_bytes).toBe(audioBytes.byteLength);
    expect(audioMediaRead.json.media.sha256_hex).toBe(sha256Hex(audioBytes));
    expect(audioMediaRead.json.media.encoding).toBe('base64');
    expect(audioMediaRead.json.media.base64_data).toBe(Buffer.from(audioBytes).toString('base64'));
    const audioMediaPayload = JSON.stringify(audioMediaRead.json).toLowerCase();
    expect(audioMediaPayload).not.toContain('storage_path');
    expect(audioMediaPayload).not.toContain('credential');
    expect(audioMediaPayload).not.toContain('secret_access_key');

    const [siblingAudioStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        size_bytes,
        storage_path
      )
      VALUES (
        ${workspaceOwner.workspace_owner_npub},
        ${OWNER_NPUB},
        'sibling-audio.webm',
        'audio/webm;codecs=opus',
        2048,
        'v4/flightdeck-pg/api/sibling-audio.webm'
      )
      RETURNING id
    `;
    const siblingAudioCreate = await requestJson(siblingAudioNotesPath, 'POST', ownerSecret, {
      title: 'Sibling hidden audio',
      storage_object_id: siblingAudioStorageObject.id,
      mime_type: 'audio/webm;codecs=opus',
      size_bytes: 2048,
    });
    expect(siblingAudioCreate.res.status).toBe(201);
    const siblingAudioNoteId = siblingAudioCreate.json.audio_note.id as string;

    const memberSiblingAudioNotes = await requestJson(siblingAudioNotesPath, 'GET', memberSecret);
    expect(memberSiblingAudioNotes.res.status).toBe(403);
    expect(memberSiblingAudioNotes.json.required_permission).toBe('audio_note.read or channel.read');

    const memberSiblingAudioMedia = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/audio-notes/${siblingAudioNoteId}/media`, 'GET', memberSecret);
    expect(memberSiblingAudioMedia.res.status).toBe(403);
    expect(memberSiblingAudioMedia.json.required_permission).toBe('audio_note.read or channel.read');

    const tasksPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/tasks`;
    const taskCreate = await requestJson(tasksPath, 'POST', ownerSecret, {
      title: 'Ship typed task API',
      description: 'Exercise task board mutations',
      priority: 'rock',
      assigned_to_npub: MEMBER_NPUB,
      metadata: { source: 'test' },
    });
    expect(taskCreate.res.status).toBe(201);
    expect(taskCreate.json.task.title).toBe('Ship typed task API');
    expect(taskCreate.json.task.state).toBe('new');
    expect(taskCreate.json.task.assigned_to_npub).toBe(MEMBER_NPUB);
    expect(taskCreate.json.task.metadata.assigned_to_npub).toBe(MEMBER_NPUB);
    expect(taskCreate.json.task.row_version).toBe(1);
    expect(taskCreate.json.outbox.row_version).toBeGreaterThan(0);
    const taskId = taskCreate.json.task.id as string;

    const siblingTasksPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${siblingChannelId}/tasks`;
    const siblingTaskCreate = await requestJson(siblingTasksPath, 'POST', ownerSecret, {
      title: 'Sibling hidden task',
    });
    expect(siblingTaskCreate.res.status).toBe(201);
    const siblingTaskId = siblingTaskCreate.json.task.id as string;

    const ownerTaskList = await requestJson(tasksPath, 'GET', ownerSecret);
    expect(ownerTaskList.res.status).toBe(200);
    expect(ownerTaskList.json.tasks.map((task: any) => task.id)).toContain(taskId);

    const memberTaskList = await requestJson(tasksPath, 'GET', memberSecret);
    expect(memberTaskList.res.status).toBe(200);
    expect(memberTaskList.json.tasks.map((task: any) => task.id)).toContain(taskId);

    const viewStatesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/resource-view-states?resource_type=task`;
    const ownerBaseline = await requestJson(viewStatesPath, 'GET', ownerSecret);
    const memberBaseline = await requestJson(viewStatesPath, 'GET', memberSecret);
    expect(ownerBaseline.res.status).toBe(200);
    expect(memberBaseline.res.status).toBe(200);
    expect(ownerBaseline.json.baseline_created).toBe(true);
    expect(memberBaseline.json.states.find((state: any) => state.resource_id === taskId).unread).toBe(false);

    const postBaselineTaskCreate = await requestJson(tasksPath, 'POST', ownerSecret, { title: 'Created after member baseline' });
    expect(postBaselineTaskCreate.res.status).toBe(201);
    const postBaselineTaskId = postBaselineTaskCreate.json.task.id as string;
    const postBaselineTaskUpdate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${postBaselineTaskId}`, 'PATCH', ownerSecret, {
      description: 'Qualifying activity after rollout',
      row_version: postBaselineTaskCreate.json.task.row_version,
    });
    expect(postBaselineTaskUpdate.res.status).toBe(200);
    const memberPostBaselineList = await requestJson(viewStatesPath, 'GET', memberSecret);
    const memberPostBaselineState = memberPostBaselineList.json.states.find((state: any) => state.resource_id === postBaselineTaskId);
    expect(memberPostBaselineState).toMatchObject({ activity_version: 1, viewed_activity_version: 0, row_version: 0, unread: true });

    const [ownerActor] = await sql<{ id: string }[]>`SELECT id FROM flightdeck_pg_actors WHERE npub=${OWNER_NPUB}`;
    await sql`
      INSERT INTO flightdeck_pg_tasks (workspace_id, scope_id, channel_id, title, created_by_actor_id, updated_by_actor_id, activity_version)
      SELECT ${workspaceId}, ${scopeId}, ${channelId}, 'Pagination task ' || sequence, ${ownerActor!.id}, ${ownerActor!.id}, 1
      FROM generate_series(1, 205) AS sequence
    `;
    const pagedStateIds: string[] = [];
    let viewStateCursor: string | null = null;
    do {
      const pagePath = `${viewStatesPath}&limit=200${viewStateCursor ? `&cursor=${encodeURIComponent(viewStateCursor)}` : ''}`;
      const page = await requestJson(pagePath, 'GET', memberSecret);
      expect(page.res.status).toBe(200);
      expect(page.json.states.length).toBeLessThanOrEqual(200);
      pagedStateIds.push(...page.json.states.map((state: any) => state.resource_id));
      viewStateCursor = page.json.next_cursor;
    } while (viewStateCursor);
    expect(new Set(pagedStateIds).size).toBeGreaterThan(200);
    expect(pagedStateIds).toContain(postBaselineTaskId);
    await sql`UPDATE flightdeck_pg_tasks SET deleted_at=NOW() WHERE workspace_id=${workspaceId} AND title LIKE 'Pagination task %'`;

    const memberSiblingTaskList = await requestJson(siblingTasksPath, 'GET', memberSecret);
    expect(memberSiblingTaskList.res.status).toBe(403);
    expect(memberSiblingTaskList.json.required_permission).toBe('task.read');

    const scopeTasksPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/tasks`;
    const memberScopeTasks = await requestJson(scopeTasksPath, 'GET', memberSecret);
    expect(memberScopeTasks.res.status).toBe(200);
    const memberScopeTaskIds = memberScopeTasks.json.tasks.map((task: any) => task.id);
    expect(memberScopeTaskIds).toContain(taskId);
    expect(memberScopeTaskIds).not.toContain(siblingTaskId);

    const taskPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}`;
    const noLeaseUpdate = await requestJson(taskPath, 'PATCH', ownerSecret, {
      title: 'Task updates do not require edit leases',
      row_version: taskCreate.json.task.row_version,
    });
    expect(noLeaseUpdate.res.status).toBe(200);
    expect(noLeaseUpdate.json.task.row_version).toBe(2);
    expect(noLeaseUpdate.json.task.title).toBe('Task updates do not require edit leases');
    expect(noLeaseUpdate.json.task.activity_version).toBe(1);
    expect(noLeaseUpdate.json.view_state_outbox.id).toBeTruthy();

    const ownerAfterOwnActivity = await requestJson(viewStatesPath, 'GET', ownerSecret);
    const memberAfterOtherActivity = await requestJson(viewStatesPath, 'GET', memberSecret);
    const ownerTaskView = ownerAfterOwnActivity.json.states.find((state: any) => state.resource_id === taskId);
    const memberTaskView = memberAfterOtherActivity.json.states.find((state: any) => state.resource_id === taskId);
    expect(ownerTaskView.viewed_activity_version).toBe(1);
    expect(ownerTaskView.unread).toBe(false);
    expect(memberTaskView.viewed_activity_version).toBe(0);
    expect(memberTaskView.unread).toBe(true);

    const memberMarkPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/resource-view-states/task/${taskId}`;
    const memberMarked = await requestJson(memberMarkPath, 'PUT', memberSecret, { viewed_activity_version: 1 });
    const memberReplay = await requestJson(memberMarkPath, 'PUT', memberSecret, { viewed_activity_version: 0 });
    expect(memberMarked.res.status).toBe(200);
    expect(memberMarked.json.changed).toBe(true);
    expect(memberMarked.json.state.unread).toBe(false);
    expect(memberReplay.res.status).toBe(200);
    expect(memberReplay.json.changed).toBe(false);
    expect(memberReplay.json.state.viewed_activity_version).toBe(1);
    expect(memberReplay.json.outbox).toBeNull();

    const bulkReplay = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/resource-view-states/mark-viewed`, 'POST', memberSecret, {
      resources: [{ resource_type: 'task', resource_id: taskId }],
    });
    expect(bulkReplay.res.status).toBe(200);
    expect(bulkReplay.json.changed_count).toBe(0);

    const ownerLease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', ownerSecret, {
      entity_type: 'task',
      entity_id: taskId,
    });
    expect(ownerLease.res.status).toBe(201);
    expect(ownerLease.json.lease.lease_token).toBeTruthy();

    const memberLeaseConflict = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', memberSecret, {
      entity_type: 'task',
      entity_id: taskId,
    });
    expect(memberLeaseConflict.res.status).toBe(409);
    expect(memberLeaseConflict.json.code).toBe('edit_lease_held');

    const memberNoWriteLease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', memberSecret, {
      entity_type: 'task',
      entity_id: siblingTaskId,
    });
    expect(memberNoWriteLease.res.status).toBe(403);

    const ownerLeaseRenew = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/${ownerLease.json.lease.id}/renew`, 'POST', ownerSecret, {
      lease_token: ownerLease.json.lease.lease_token,
    });
    expect(ownerLeaseRenew.res.status).toBe(200);
    expect(ownerLeaseRenew.json.lease.lease_token).toBe(ownerLease.json.lease.lease_token);

    const ownerUpdate = await requestJson(taskPath, 'PATCH', ownerSecret, {
      title: 'Ship typed task API service',
      assigned_to_npub: GROUP_MEMBER_NPUB,
      row_version: noLeaseUpdate.json.task.row_version,
      lease_token: ownerLease.json.lease.lease_token,
    });
    expect(ownerUpdate.res.status).toBe(200);
    expect(ownerUpdate.json.task.row_version).toBe(3);
    expect(ownerUpdate.json.task.title).toBe('Ship typed task API service');
    expect(ownerUpdate.json.task.description).toBe('Exercise task board mutations');
    expect(ownerUpdate.json.task.assigned_to_npub).toBe(GROUP_MEMBER_NPUB);
    expect(ownerUpdate.json.task.metadata.assigned_to_npub).toBe(GROUP_MEMBER_NPUB);

    const descriptionClear = await requestJson(taskPath, 'PATCH', ownerSecret, {
      description: null,
      row_version: ownerUpdate.json.task.row_version,
      lease_token: ownerLease.json.lease.lease_token,
    });
    expect(descriptionClear.res.status).toBe(200);
    expect(descriptionClear.json.task.row_version).toBe(4);
    expect(descriptionClear.json.task.description).toBeNull();

    const [storedDescriptionClear] = await sql<{ description: string | null; row_version: number; assigned_to_npub: string | null }[]>`
      SELECT description, row_version, metadata->>'assigned_to_npub' AS assigned_to_npub
      FROM flightdeck_pg_tasks
      WHERE id = ${taskId}
    `;
    expect(storedDescriptionClear.description).toBeNull();
    expect(storedDescriptionClear.row_version).toBe(4);
    expect(storedDescriptionClear.assigned_to_npub).toBe(GROUP_MEMBER_NPUB);

    const staleUpdate = await requestJson(taskPath, 'PATCH', memberSecret, {
      priority: 'urgent',
      row_version: 1,
      lease_token: ownerLease.json.lease.lease_token,
    });
    expect(staleUpdate.res.status).toBe(200);
    expect(staleUpdate.json.task.priority).toBe('urgent');
    expect(staleUpdate.json.task.row_version).toBe(5);

    const ownerStaleUpdate = await requestJson(taskPath, 'PATCH', ownerSecret, {
      priority: 'high',
      row_version: 1,
      lease_token: ownerLease.json.lease.lease_token,
    });
    expect(ownerStaleUpdate.res.status).toBe(200);
    expect(ownerStaleUpdate.json.task.priority).toBe('high');
    expect(ownerStaleUpdate.json.task.row_version).toBe(6);

    const ownerLeaseRelease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/${ownerLease.json.lease.id}/release`, 'POST', ownerSecret, {
      lease_token: ownerLease.json.lease.lease_token,
    });
    expect(ownerLeaseRelease.res.status).toBe(200);
    expect(ownerLeaseRelease.json.released).toBe(true);

    const expiredOwnerLease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', ownerSecret, {
      entity_type: 'task',
      entity_id: taskId,
    });
    expect(expiredOwnerLease.res.status).toBe(201);
    await sql`
      UPDATE flightdeck_pg_edit_leases
      SET expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${expiredOwnerLease.json.lease.id}
    `;

    const memberReclaimedLease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', memberSecret, {
      entity_type: 'task',
      entity_id: taskId,
    });
    expect(memberReclaimedLease.res.status).toBe(201);
    expect(memberReclaimedLease.json.lease.lease_token).toBeTruthy();

    const stateWithoutLease = await requestJson(`${taskPath}/state`, 'POST', memberSecret, {
      state: 'in_progress',
      row_version: descriptionClear.json.task.row_version,
    });
    expect(stateWithoutLease.res.status).toBe(200);
    expect(stateWithoutLease.json.task.state).toBe('in_progress');
    expect(stateWithoutLease.json.task.row_version).toBe(7);

    const stateWithoutRowVersion = await requestJson(`${taskPath}/state`, 'POST', memberSecret, {
      state: 'done',
    });
    expect(stateWithoutRowVersion.res.status).toBe(200);
    expect(stateWithoutRowVersion.json.task.state).toBe('done');
    expect(stateWithoutRowVersion.json.task.row_version).toBe(8);

    const staleStateUpdate = await requestJson(`${taskPath}/state`, 'POST', memberSecret, {
      state: 'in_progress',
      row_version: 1,
    });
    expect(staleStateUpdate.res.status).toBe(200);
    expect(staleStateUpdate.json.task.state).toBe('in_progress');
    expect(staleStateUpdate.json.task.row_version).toBe(9);

    const memberStateUpdate = await requestJson(`${taskPath}/state`, 'POST', memberSecret, {
      state: 'done',
      row_version: stateWithoutRowVersion.json.task.row_version,
    });
    expect(memberStateUpdate.res.status).toBe(200);
    expect(memberStateUpdate.json.task.state).toBe('done');
    expect(memberStateUpdate.json.task.row_version).toBe(10);

    const commentsPath = `${taskPath}/comments`;
    const memberComment = await requestJson(commentsPath, 'POST', memberSecret, {
      body: 'Collaborator can comment on an allowed channel task.',
    });
    expect(memberComment.res.status).toBe(201);
    expect(memberComment.json.comment.task_id).toBe(taskId);
    expect(memberComment.json.comment.row_version).toBe(1);

    const commentsList = await requestJson(commentsPath, 'GET', ownerSecret);
    expect(commentsList.res.status).toBe(200);
    expect(commentsList.json.comments.map((comment: any) => comment.id)).toContain(memberComment.json.comment.id);

    const reactionsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/reactions`;
    const memberDeniedReactionCreate = await requestJson(reactionsPath, 'POST', memberSecret, {
      target_type: 'message',
      target_id: rootMessageId,
      emoji: 'thumbs_up',
    });
    expect(memberDeniedReactionCreate.res.status).toBe(403);
    expect(memberDeniedReactionCreate.json.required_permission).toBe('channel.write');

    const reactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'message',
      target_id: rootMessageId,
      emoji: 'thumbs_up',
    });
    expect(reactionCreate.res.status).toBe(201);
    expectFixtureRequiredKeys(reactionCreate.json, 'reactions-create.json');
    expect(reactionCreate.json.reaction.target_type).toBe('message');
    expect(reactionCreate.json.reaction.target_id).toBe(rootMessageId);
    expect(reactionCreate.json.reaction.emoji).toBe('thumbs_up');
    expect(reactionCreate.json.reaction.emoji_shortcode).toBe(':thumbs_up:');
    expect(reactionCreate.json.reaction.record_state).toBe('active');
    const reactionId = reactionCreate.json.reaction.id as string;

    const duplicateReactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'message',
      target_id: rootMessageId,
      emoji: 'thumbs_up',
    });
    expect(duplicateReactionCreate.res.status).toBe(201);
    expect(duplicateReactionCreate.json.reaction.id).toBe(reactionId);

    const whiteCheckReactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'message',
      target_id: rootMessageId,
      emoji: 'white_check_mark',
    });
    expect(whiteCheckReactionCreate.res.status).toBe(201);
    expect(whiteCheckReactionCreate.json.reaction.emoji).toBe('white_check_mark');
    expect(whiteCheckReactionCreate.json.reaction.emoji_shortcode).toBe(':white_check_mark:');

    const commentReactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'task_comment',
      target_id: memberComment.json.comment.id,
      emoji: 'heart',
    });
    expect(commentReactionCreate.res.status).toBe(201);
    expect(commentReactionCreate.json.reaction.target_type).toBe('task_comment');
    expect(commentReactionCreate.json.reaction.target_id).toBe(memberComment.json.comment.id);

    const audioNoteReactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'audio_note',
      target_id: audioNoteId,
      emoji: 'party',
    });
    expect(audioNoteReactionCreate.res.status).toBe(201);
    expect(audioNoteReactionCreate.json.reaction.target_type).toBe('audio_note');
    expect(audioNoteReactionCreate.json.reaction.target_id).toBe(audioNoteId);
    expect(audioNoteReactionCreate.json.reaction.thread_id).toBe(threadId);

    const memberAudioNoteReactions = await requestJson(`${reactionsPath}?target_type=audio_note&target_id=${audioNoteId}`, 'GET', memberSecret);
    expect(memberAudioNoteReactions.res.status).toBe(200);
    expect(memberAudioNoteReactions.json.reactions.map((reaction: any) => reaction.id)).toContain(audioNoteReactionCreate.json.reaction.id);

    const badReactionTargetType = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'encrypted_record',
      target_id: rootMessageId,
      emoji: 'heart',
    });
    expect(badReactionTargetType.res.status).toBe(400);
    expect(badReactionTargetType.json.code).toBe('validation_error');

    const badReactionEmoji = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'message',
      target_id: rootMessageId,
      emoji: 'not_allowed',
    });
    expect(badReactionEmoji.res.status).toBe(400);
    expect(badReactionEmoji.json.code).toBe('validation_error');

    const missingReactionTarget = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'message',
      target_id: '00000000-0000-4000-8000-000000000000',
      emoji: 'heart',
    });
    expect(missingReactionTarget.res.status).toBe(404);
    expect(missingReactionTarget.json.code).toBe('reaction_target_not_found');

    const memberReactions = await requestJson(`${reactionsPath}?target_type=message&target_id=${rootMessageId}`, 'GET', memberSecret);
    expect(memberReactions.res.status).toBe(200);
    expectFixtureRequiredKeys(memberReactions.json, 'reactions-list.json');
    expect(memberReactions.json.reactions.map((reaction: any) => reaction.id)).toContain(reactionId);

    const siblingReactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'message',
      target_id: siblingMessageId,
      emoji: 'eyes',
    });
    expect(siblingReactionCreate.res.status).toBe(201);

    const memberSiblingReactions = await requestJson(`${reactionsPath}?target_type=message&target_id=${siblingMessageId}`, 'GET', memberSecret);
    expect(memberSiblingReactions.res.status).toBe(403);
    expect(memberSiblingReactions.json.required_permission).toBe('channel.read');

    const siblingAudioNoteReactionCreate = await requestJson(reactionsPath, 'POST', ownerSecret, {
      target_type: 'audio_note',
      target_id: siblingAudioNoteId,
      emoji: 'eyes',
    });
    expect(siblingAudioNoteReactionCreate.res.status).toBe(201);

    const memberSiblingAudioNoteReactions = await requestJson(`${reactionsPath}?target_type=audio_note&target_id=${siblingAudioNoteId}`, 'GET', memberSecret);
    expect(memberSiblingAudioNoteReactions.res.status).toBe(403);
    expect(memberSiblingAudioNoteReactions.json.required_permission).toBe('channel.read');

    const reactionDelete = await requestJson(`${reactionsPath}/${reactionId}`, 'DELETE', ownerSecret);
    expect(reactionDelete.res.status).toBe(200);
    expectFixtureRequiredKeys(reactionDelete.json, 'reactions-delete.json');
    expect(reactionDelete.json.reaction.record_state).toBe('deleted');

    const memberReactionsAfterDelete = await requestJson(`${reactionsPath}?target_type=message&target_id=${rootMessageId}`, 'GET', memberSecret);
    expect(memberReactionsAfterDelete.res.status).toBe(200);
    expect(memberReactionsAfterDelete.json.reactions.map((reaction: any) => reaction.id)).not.toContain(reactionId);

    const assignmentCreate = await requestJson(`${taskPath}/assignments`, 'POST', ownerSecret, {
      actor_id: memberCreate.json.actor.actor_id,
    });
    expect(assignmentCreate.res.status).toBe(201);
    expect(assignmentCreate.json.assignment.actor_id).toBe(memberCreate.json.actor.actor_id);
    expect(assignmentCreate.json.assignment.actor_npub).toBe(memberCreate.json.actor.npub);

    const taskAfterAssignment = await requestJson(taskPath, 'GET', ownerSecret);
    expect(taskAfterAssignment.res.status).toBe(200);
    expect(taskAfterAssignment.json.task.assignments).toEqual([
      expect.objectContaining({
        actor_id: memberCreate.json.actor.actor_id,
        actor_npub: memberCreate.json.actor.npub,
      }),
    ]);

    const assignmentDelete = await requestJson(`${taskPath}/assignments/${memberCreate.json.actor.actor_id}`, 'DELETE', ownerSecret);
    expect(assignmentDelete.res.status).toBe(200);
    expect(assignmentDelete.json.assignment.actor_id).toBe(memberCreate.json.actor.actor_id);

    const [taskEventCounts] = await sql<{ outbox_count: string; audit_count: string }[]>`
      SELECT
        (SELECT COUNT(*)::text FROM flightdeck_pg_outbox_events WHERE workspace_id = ${workspaceId} AND entity_type LIKE 'task%') AS outbox_count,
        (SELECT COUNT(*)::text FROM flightdeck_pg_audit_events WHERE workspace_id = ${workspaceId} AND action LIKE 'task%') AS audit_count
    `;
    expect(Number(taskEventCounts.outbox_count)).toBeGreaterThanOrEqual(7);
    expect(Number(taskEventCounts.audit_count)).toBeGreaterThanOrEqual(7);

    const eventsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=200`;
    const ownerEvents = await requestJson(eventsPath, 'GET', ownerSecret);
    expect(ownerEvents.res.status).toBe(200);
    const ownerEventEntityIds = ownerEvents.json.events.map((event: any) => event.entity_id);
    expect(ownerEventEntityIds).toContain(taskId);
    expect(ownerEventEntityIds).toContain(siblingTaskId);
    expect(ownerEventEntityIds).toContain(rootMessageId);
    expect(ownerEventEntityIds).toContain(threadId);
    expect(ownerEventEntityIds).toContain(siblingMessageId);
    expect(ownerEventEntityIds).toContain(docId);
    expect(ownerEventEntityIds).toContain(siblingDocId);
    expect(ownerEventEntityIds).toContain(audioNoteId);
    expect(ownerEventEntityIds).toContain(siblingAudioNoteId);
    expect(ownerEventEntityIds).toContain(reactionId);
    expect(ownerEventEntityIds).toContain(siblingReactionCreate.json.reaction.id);

    const memberEvents = await requestJson(eventsPath, 'GET', memberSecret);
    expect(memberEvents.res.status).toBe(200);
    expectFixtureRequiredKeys(memberEvents.json, 'events-list.json');
    expect(memberEvents.json.cursor_semantics.since).toContain('greater than');
    expect(memberEvents.json.next_cursor).toBeTruthy();
    const memberEventEntityIds = memberEvents.json.events.map((event: any) => event.entity_id);
    expect(memberEventEntityIds).toContain(taskId);
    expect(memberEventEntityIds).toContain(rootMessageId);
    expect(memberEventEntityIds).toContain(threadId);
    expect(memberEventEntityIds).toContain(docId);
    expect(memberEventEntityIds).toContain(audioNoteId);
    expect(memberEventEntityIds).toContain(reactionId);
    expect(memberEventEntityIds).not.toContain(siblingTaskId);
    expect(memberEventEntityIds).not.toContain(siblingMessageId);
    expect(memberEventEntityIds).not.toContain(siblingDocId);
    expect(memberEventEntityIds).not.toContain(siblingAudioNoteId);
    expect(memberEventEntityIds).not.toContain(siblingReactionCreate.json.reaction.id);
    expect(memberEvents.json.events.every((event: any) => [channelId, dmChannelId].includes(event.channel_id))).toBe(true);
    expect(memberEvents.json.events.every((event: any) => event.cursor && event.event_id && event.timestamp && event.refetch)).toBe(true);

    const memberSnapshotPages = [];
    let memberSnapshotCursor = '';
    do {
      const page = await requestJson(
        `/api/v4/flightdeck-pg/workspaces/${workspaceId}/sync?limit=500${memberSnapshotCursor ? `&cursor=${encodeURIComponent(memberSnapshotCursor)}` : ''}`,
        'GET',
        memberSecret,
      );
      memberSnapshotPages.push(page);
      memberSnapshotCursor = page.json.has_more ? page.json.next_cursor : '';
    } while (memberSnapshotCursor);
    const memberSnapshot = memberSnapshotPages[0];
    const memberSnapshotChannels = memberSnapshotPages.flatMap((page) => page.json.channels);
    const memberSnapshotBundles = memberSnapshotPages.flatMap((page) => page.json.channel_bundles);
    expect(memberSnapshot.res.status).toBe(200);
    expect(memberSnapshot.json.mode).toBe('snapshot');
    expect(memberSnapshot.json.full_snapshot).toBe(true);
    expect(memberSnapshot.json.next_cursor).toBeTruthy();
    expect(memberSnapshotPages.at(-1)?.json.snapshot_complete).toBe(true);
    expect(memberSnapshotPages.every((page) => page.json.channel_bundles.every((bundle: any) => bundle.messages.length <= 500))).toBe(true);
    expect(memberSnapshotChannels.map((channel: any) => channel.id)).toContain(channelId);
    expect(memberSnapshotChannels.map((channel: any) => channel.id)).not.toContain(siblingChannelId);
    const syncedChannelPages = memberSnapshotBundles.filter((bundle: any) => bundle.channel_id === channelId);
    const syncedChannel = {
      messages: syncedChannelPages.flatMap((bundle: any) => bundle.messages),
      tasks: syncedChannelPages.flatMap((bundle: any) => bundle.tasks),
      docs: syncedChannelPages.flatMap((bundle: any) => bundle.docs),
    };
    expect(syncedChannel.messages.map((message: any) => message.id)).toContain(rootMessageId);
    expect(syncedChannel.tasks.map((task: any) => task.id)).toContain(taskId);
    expect(syncedChannel.docs.map((doc: any) => doc.id)).toContain(docId);
    expect(memberSnapshotBundles.some((bundle: any) => bundle.channel_id === siblingChannelId)).toBe(false);
    const hiddenSnapshotCursor = Buffer.from(JSON.stringify({
      version: 2,
      kind: 'workspace_snapshot',
      throughRowVersion: 0,
      channelId: siblingChannelId,
      messageCreatedAt: null,
      messageId: null,
    }), 'utf8').toString('base64url');
    const hiddenSnapshotPage = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/sync?cursor=${encodeURIComponent(hiddenSnapshotCursor)}`,
      'GET',
      memberSecret,
    );
    expect(hiddenSnapshotPage.res.status).toBe(400);

    const zeroCursor = Buffer.from(JSON.stringify({ version: 1, rowVersion: 0 }), 'utf8').toString('base64url');
    const memberStreamPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events/stream?cursor=${encodeURIComponent(zeroCursor)}&limit=50`;
    const memberStream = await app.request(memberStreamPath, {
      method: 'GET',
      headers: {
        Authorization: authHeader(memberStreamPath, 'GET', memberSecret),
      },
    });
    expect(memberStream.status).toBe(200);
    expect(memberStream.headers.get('Content-Type')).toContain('text/event-stream');
    const memberStreamPreview = await readSsePreview(memberStream, (text) => text.includes(rootMessageId));
    expect(memberStreamPreview).toContain('event: connected');
    expect(memberStreamPreview).toContain('event: flightdeck_pg.event');
    expect(memberStreamPreview).toContain(rootMessageId);
    expect(memberStreamPreview).not.toContain(siblingMessageId);

    const changedHeaderStream = await app.request(
      memberStreamPath.replace('limit=50', 'limit=51'),
      {
        method: 'GET',
        headers: {
          Authorization: authHeader(memberStreamPath, 'GET', memberSecret),
        },
      },
    );
    expect(changedHeaderStream.status).toBe(401);

    const browserStreamBasePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events/stream`;
    const browserStreamSemanticPath = `${browserStreamBasePath}?cursor=${encodeURIComponent(zeroCursor)}&limit=50`;
    const browserStreamToken = authHeader(browserStreamSemanticPath, 'GET', memberSecret).slice('Nostr '.length);
    const browserStream = await app.request(
      `${browserStreamSemanticPath}&token=${encodeURIComponent(browserStreamToken)}`,
      { method: 'GET' },
    );
    expect(browserStream.status).toBe(200);
    expect(browserStream.headers.get('Content-Type')).toContain('text/event-stream');
    const browserStreamPreview = await readSsePreview(browserStream, (text) => text.includes(rootMessageId));
    expect(browserStreamPreview).toContain('event: connected');
    expect(browserStreamPreview).toContain('event: flightdeck_pg.event');
    expect(browserStreamPreview).toContain(rootMessageId);
    expect(browserStreamPreview).not.toContain(siblingMessageId);

    const changedCursorStream = await app.request(
      `${browserStreamBasePath}?cursor=${encodeURIComponent(memberEvents.json.next_cursor)}&limit=50&token=${encodeURIComponent(browserStreamToken)}`,
      { method: 'GET' },
    );
    expect(changedCursorStream.status).toBe(401);
    const duplicateBrowserToken = await app.request(
      `${browserStreamSemanticPath}&token=${encodeURIComponent(browserStreamToken)}&token=${encodeURIComponent(browserStreamToken)}`,
      { method: 'GET' },
    );
    expect(duplicateBrowserToken.status).toBe(401);
    const emptyBrowserToken = await app.request(`${browserStreamSemanticPath}&token=`, {
      method: 'GET',
      headers: { Authorization: authHeader(browserStreamSemanticPath, 'GET', memberSecret) },
    });
    expect(emptyBrowserToken.status).toBe(401);

    const firstVisibleEvent = memberEvents.json.events[0];
    const memberDelta = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/sync?cursor=${encodeURIComponent(firstVisibleEvent.cursor)}&limit=500`,
      'GET',
      memberSecret,
    );
    expect(memberDelta.res.status).toBe(200);
    expect(memberDelta.json.mode).toBe('delta');
    expect(memberDelta.json.full_snapshot).toBe(false);
    expect(memberDelta.json.next_cursor).toBeTruthy();
    expect(memberDelta.json.channel_bundles.some((bundle: any) => bundle.channel_id === channelId)).toBe(true);
    expect(memberDelta.json.channel_bundles.some((bundle: any) => bundle.channel_id === siblingChannelId)).toBe(false);
    const newerEvents = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?cursor=${encodeURIComponent(firstVisibleEvent.cursor)}&limit=50`,
      'GET',
      memberSecret,
    );
    expect(newerEvents.res.status).toBe(200);
    expect(newerEvents.json.events.map((event: any) => event.event_id)).not.toContain(firstVisibleEvent.event_id);
    expect(newerEvents.json.events.every((event: any) => event.row_version > firstVisibleEvent.row_version)).toBe(true);

    const invalidCursor = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?since=not-a-cursor`,
      'GET',
      memberSecret,
    );
    expect(invalidCursor.res.status).toBe(400);
    expect(invalidCursor.json.code).toBe('validation_error');
  }, 20_000);

  test('authorizes an identity-neutral manager subscription and returns a cursor-stable visibility union without DM leakage', async () => {
    const { workspaceId, ownerId } = await seedWorkspace('npub1workspacemultiagentevents');
    const manager = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, { member_npub: DM_ONLY_NPUB, role: 'member', kind: 'human', display_name: 'Autopilot Manager' });
    const secondaryAgent = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, { member_npub: AGENT_NPUB, role: 'member', kind: 'human', display_name: 'Secondary Identity' });
    const agent = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, { member_npub: INACCESSIBLE_AGENT_NPUB, role: 'member', kind: 'human', display_name: 'Ordinary Identity' });
    expect(manager.res.status).toBe(201);
    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id, principal_type, principal_actor_id, resource_type, permission, created_by_actor_id
      ) VALUES
        (${workspaceId}, 'actor', ${manager.json.actor.actor_id}, 'workspace', 'workspace.read', ${ownerId}),
        (${workspaceId}, 'actor', ${manager.json.actor.actor_id}, 'workspace', 'event_subscription.manage', ${ownerId})
    `;
    expect(secondaryAgent.res.status).toBe(201);
    expect(agent.res.status).toBe(201);

    const unauthorizedPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?audience_npub=${encodeURIComponent(AGENT_NPUB)}&limit=50`;
    const unauthorized = await requestJson(unauthorizedPath, 'GET', agentSecret);
    expect(unauthorized.res.status).toBe(403);
    expect(unauthorized.json.required_permission).toBe('event_subscription.manage');

    const reconcilePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/event-subscription-agents`;
    const reconciled = await requestJson(reconcilePath, 'PUT', dmOnlySecret, { audience_npubs: [AGENT_NPUB, INACCESSIBLE_AGENT_NPUB, UNKNOWN_AGENT_NPUB] });
    expect(reconciled.res.status).toBe(200);
    expect(reconciled.json.agent_npubs).toEqual([AGENT_NPUB, INACCESSIBLE_AGENT_NPUB].sort());
    expect(reconciled.json.audience_npubs).toEqual([AGENT_NPUB, INACCESSIBLE_AGENT_NPUB].sort());
    expect(reconciled.json.rejected_audience).toEqual([{ npub: UNKNOWN_AGENT_NPUB, code: 'inactive_or_unknown_workspace_member' }]);

    const scope = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, { name: 'Agent event scope', kind: 'project' });
    const channelsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scope.json.scope.id}/channels`;
    const ordinary = await requestJson(channelsPath, 'POST', ownerSecret, { name: 'Agent channel', kind: 'channel' });
    await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${ordinary.json.channel.id}/grants`, 'POST', ownerSecret, { principal_type: 'actor', principal_id: agent.json.actor.actor_id, access_level: 'contribute' });
    const dm = await requestJson(channelsPath, 'POST', ownerSecret, { name: 'Operator and Secondary Agent', kind: 'dm', participant_npubs: [OWNER_NPUB, AGENT_NPUB] });
    const ordinaryBody = 'Agent-visible ordinary message';
    const ordinaryMessage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${ordinary.json.channel.id}/messages`, 'POST', ownerSecret, { body: ordinaryBody, message_signature: messageSignature({ body: ordinaryBody, secret: ownerSecret, workspaceId, channelId: ordinary.json.channel.id }) });
    const dmBody = 'Operator to Secondary Agent private DM';
    const dmMessage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${dm.json.channel.id}/messages`, 'POST', ownerSecret, { body: dmBody, message_signature: messageSignature({ body: dmBody, secret: ownerSecret, workspaceId, channelId: dm.json.channel.id }) });
    expect(ordinaryMessage.res.status).toBe(201);
    expect(dmMessage.res.status).toBe(201);

    const zeroCursor = Buffer.from(JSON.stringify({ version: 1, rowVersion: 0 }), 'utf8').toString('base64url');
    const unionPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?cursor=${encodeURIComponent(zeroCursor)}&audience_npub=${encodeURIComponent(AGENT_NPUB)}&audience_npub=${encodeURIComponent(INACCESSIBLE_AGENT_NPUB)}&limit=200`;
    const union = await requestJson(unionPath, 'GET', dmOnlySecret);
    expect(union.res.status).toBe(200);
    expect(union.json.subscription_audience_npubs).toEqual([AGENT_NPUB, INACCESSIBLE_AGENT_NPUB].sort());
    const dmEvent = union.json.events.find((event: any) => event.entity_id === dmMessage.json.message.id);
    const ordinaryEvent = union.json.events.find((event: any) => event.entity_id === ordinaryMessage.json.message.id);
    expect(dmEvent.visible_to_agent_npubs).toEqual([AGENT_NPUB]);
    expect(dmEvent.visible_to_audience_npubs).toEqual([AGENT_NPUB]);
    expect(ordinaryEvent.visible_to_agent_npubs).toEqual([INACCESSIBLE_AGENT_NPUB]);
    expect(ordinaryEvent.visible_to_audience_npubs).toEqual([INACCESSIBLE_AGENT_NPUB]);
    expect(union.json.next_cursor).toBe(union.json.through_cursor);

    const agentOnlyPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?cursor=${encodeURIComponent(zeroCursor)}&audience_npub=${encodeURIComponent(INACCESSIBLE_AGENT_NPUB)}&limit=200`;
    const agentOnly = await requestJson(agentOnlyPath, 'GET', dmOnlySecret);
    expect(agentOnly.res.status).toBe(200);
    expect(agentOnly.json.events.map((event: any) => event.entity_id)).not.toContain(dmMessage.json.message.id);

    const replay = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?cursor=${encodeURIComponent(union.json.next_cursor)}&audience_npub=${encodeURIComponent(AGENT_NPUB)}&audience_npub=${encodeURIComponent(INACCESSIBLE_AGENT_NPUB)}&limit=200`, 'GET', dmOnlySecret);
    expect(replay.res.status).toBe(200);
    expect(replay.json.events).toHaveLength(0);
    expect(replay.json.next_cursor).toBe(union.json.next_cursor);

    const legacySecondaryAgent = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=200`, 'GET', agentSecret);
    expect(legacySecondaryAgent.res.status).toBe(200);
    expect(legacySecondaryAgent.json.subscription_audience_npubs).toBeUndefined();
    expect(legacySecondaryAgent.json.events.find((event: any) => event.entity_id === dmMessage.json.message.id).visible_to_agent_npubs).toBeUndefined();

    const streamPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events/stream?cursor=${encodeURIComponent(union.json.next_cursor)}&audience_npub=${encodeURIComponent(AGENT_NPUB)}&audience_npub=${encodeURIComponent(INACCESSIBLE_AGENT_NPUB)}&limit=200`;
    const changedAudiencePath = streamPath.replace(
      `audience_npub=${encodeURIComponent(INACCESSIBLE_AGENT_NPUB)}`,
      `audience_npub=${encodeURIComponent(UNKNOWN_AGENT_NPUB)}`,
    );
    const changedAudience = await app.request(changedAudiencePath, {
      method: 'GET',
      headers: { Authorization: authHeader(streamPath, 'GET', dmOnlySecret) },
    });
    expect(changedAudience.status).toBe(401);
    const stream = await app.request(streamPath, {
      method: 'GET',
      headers: { Authorization: authHeader(streamPath, 'GET', dmOnlySecret) },
    });
    expect(stream.status).toBe(200);
    await sql`
      DELETE FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceId}
        AND actor_id = ${secondaryAgent.json.actor.actor_id}
    `;
    const afterRemovalBody = 'Still visible after another audience identity is removed';
    const afterRemovalMessage = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${ordinary.json.channel.id}/messages`, 'POST', ownerSecret, {
      body: afterRemovalBody,
      message_signature: messageSignature({ body: afterRemovalBody, secret: ownerSecret, workspaceId, channelId: ordinary.json.channel.id }),
    });
    expect(afterRemovalMessage.res.status).toBe(201);
    const streamPreview = await readSsePreview(stream, (text) => text.includes('flightdeck_pg.audience_changed') && text.includes(afterRemovalMessage.json.message.id));
    expect(streamPreview).toContain('event: flightdeck_pg.audience_changed');
    expect(streamPreview).toContain(AGENT_NPUB);
    expect(streamPreview).toContain(afterRemovalMessage.json.message.id);
    expect(streamPreview).toContain(`"visible_to_audience_npubs":["${INACCESSIBLE_AGENT_NPUB}"]`);
  }, 20_000);

  test('publishes, hydrates, sequences, terminates, expires, and authorizes agent activity snapshots', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgagentactivity');
    const agentMember = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, {
      member_npub: AGENT_NPUB,
      role: 'agent',
      kind: 'agent',
      display_name: 'Activity Agent',
    });
    const deniedAgentMember = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, {
      member_npub: INACCESSIBLE_AGENT_NPUB,
      role: 'agent',
      kind: 'agent',
      display_name: 'Read-only Agent',
    });
    expect(agentMember.res.status).toBe(201);
    expect(deniedAgentMember.res.status).toBe(201);
    const scope = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, { name: 'Live Activity', kind: 'project' });
    const channel = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scope.json.scope.id}/channels`, 'POST', ownerSecret, {
      name: 'Agent Activity',
      kind: 'channel',
      grants: [
        { principal_type: 'actor', principal_id: agentMember.json.actor.actor_id, access_level: 'contribute' },
        { principal_type: 'actor', principal_id: deniedAgentMember.json.actor.actor_id, access_level: 'view' },
      ],
    });
    expect(channel.res.status).toBe(201);
    const channelId = channel.json.channel.id as string;
    const triggerBody = 'Please investigate this';
    const trigger = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/messages`, 'POST', ownerSecret, {
      body: triggerBody,
      create_thread: true,
      message_signature: messageSignature({ body: triggerBody, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(trigger.res.status).toBe(201);
    const threadId = trigger.json.thread.id as string;
    const triggerMessageId = trigger.json.message.id as string;
    const activityId = 'session-activity-1';
    const activityPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/agent-activities/${activityId}`;
    const base = {
      channel_id: channelId,
      thread_id: threadId,
      trigger_message_id: triggerMessageId,
      turn_id: 'turn-activity-1',
      session_id: 'session-1',
      agent_npub: AGENT_NPUB,
      visibility: 'user_visible',
      expires_in_seconds: 300,
    };
    // Autopilot seeds activity versions from Date.now() * 1000. This must stay
    // above the PostgreSQL int4 range to guard the transactional outbox seam.
    const timestampScaleSequence = 1_784_873_857_635_001;

    const missingTurn = await requestJson(activityPath, 'PUT', agentSecret, { ...base, turn_id: undefined, state: 'accepted', sequence: timestampScaleSequence });
    expect(missingTurn.res.status).toBe(400);
    expect(missingTurn.json.details.fields).toContainEqual(expect.objectContaining({ path: 'turn_id', code: 'required' }));

    const denied = await requestJson(activityPath, 'PUT', inaccessibleAgentSecret, { ...base, agent_npub: INACCESSIBLE_AGENT_NPUB, state: 'accepted', sequence: timestampScaleSequence });
    expect(denied.res.status).toBe(403);

    const created = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'accepted', sequence: timestampScaleSequence, label: 'Accepted', summary: 'Dispatch accepted' });
    expect(created.res.status).toBe(201);
    expect(created.json.agent_activity).toMatchObject({ activity_id: activityId, turn_id: base.turn_id, state: 'accepted', sequence: timestampScaleSequence, visibility: 'user_visible' });
    expect(created.json.agent_activity.created_at).toBeTruthy();
    expect(created.json.outbox).toEqual(expect.objectContaining({ id: expect.any(String), row_version: expect.any(Number) }));
    const lifecycleCreatedAt = created.json.agent_activity.created_at;

    const updated = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'working', sequence: timestampScaleSequence + 1, label: 'Checking', summary: 'Reading Tower routes', body: 'Inspecting the typed route and SSE seams.' });
    expect(updated.res.status).toBe(200);
    expect(updated.json.agent_activity).toMatchObject({ turn_id: base.turn_id, state: 'working', sequence: timestampScaleSequence + 1, summary: 'Reading Tower routes', created_at: lifecycleCreatedAt });
    expect(updated.json.outbox).toEqual(expect.objectContaining({ id: expect.any(String), row_version: expect.any(Number) }));

    const exactReplay = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'working', sequence: timestampScaleSequence + 1, label: 'Checking', summary: 'Reading Tower routes', body: 'Inspecting the typed route and SSE seams.' });
    expect(exactReplay.res.status).toBe(200);
    expect(exactReplay.json.idempotent).toBe(true);
    expect(exactReplay.json.outbox).toBeNull();

    const secondUpdate = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'working', sequence: timestampScaleSequence + 2, label: 'Testing', summary: 'Locking replay behavior', body: 'Adding ordered hydration coverage.' });
    expect(secondUpdate.res.status).toBe(200);

    const mutatedTurn = await requestJson(activityPath, 'PUT', agentSecret, { ...base, turn_id: 'turn-activity-other', state: 'working', sequence: timestampScaleSequence + 3, body: 'Must not cross turns.' });
    expect(mutatedTurn.res.status).toBe(409);
    expect(mutatedTurn.json.code).toBe('agent_activity_turn_identity_mismatch');
    expect(mutatedTurn.json.current).toMatchObject({ turn_id: base.turn_id, sequence: timestampScaleSequence + 2 });

    const stale = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'working', sequence: timestampScaleSequence + 1, body: 'Must not append twice.' });
    expect(stale.res.status).toBe(409);
    expect(stale.json.code).toBe('stale_agent_activity_sequence');
    expect(stale.json.current.sequence).toBe(timestampScaleSequence + 2);

    const terminal = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'completed', sequence: timestampScaleSequence + 3, label: 'Completed', summary: 'Final answer summary', body: 'Final answer must not enter commentary.' });
    expect(terminal.res.status).toBe(200);
    expect(terminal.json.agent_activity.terminal_at).toBeTruthy();
    const terminalReplay = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'completed', sequence: timestampScaleSequence + 3, label: 'Completed', summary: 'Final answer summary', body: 'Final answer must not enter commentary.' });
    expect(terminalReplay.res.status).toBe(200);
    expect(terminalReplay.json.idempotent).toBe(true);
    expect(terminalReplay.json.outbox).toBeNull();
    const afterTerminal = await requestJson(activityPath, 'PUT', agentSecret, { ...base, state: 'working', sequence: timestampScaleSequence + 4 });
    expect(afterTerminal.res.status).toBe(409);
    expect(afterTerminal.json.code).toBe('agent_activity_terminal');

    const hydratePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/agent-activities?channel_id=${channelId}&thread_id=${threadId}`;
    const hydrated = await requestJson(hydratePath, 'GET', ownerSecret);
    expect(hydrated.res.status).toBe(200);
    expect(hydrated.json.agent_activities).toHaveLength(1);
    expect(hydrated.json.agent_activities[0]).toMatchObject({ turn_id: base.turn_id, sequence: timestampScaleSequence + 3, created_at: lifecycleCreatedAt });
    expect(hydrated.json.agent_activities[0].commentary_history).toEqual([
      expect.objectContaining({ turn_id: base.turn_id, activity_id: activityId, sequence: timestampScaleSequence + 1, summary: 'Reading Tower routes', body: 'Inspecting the typed route and SSE seams.', created_at: expect.any(String) }),
      expect.objectContaining({ turn_id: base.turn_id, activity_id: activityId, sequence: timestampScaleSequence + 2, summary: 'Locking replay behavior', body: 'Adding ordered hydration coverage.', created_at: expect.any(String) }),
    ]);
    expect(hydrated.json.agent_activities[0].commentary_history.some((entry: any) => entry.body === 'Final answer must not enter commentary.')).toBe(false);
    const visibleEvents = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=200`, 'GET', ownerSecret);
    const activityEvents = visibleEvents.json.events.filter((event: any) => event.event_type === 'flightdeck_pg.agent_activity.snapshot');
    expect(activityEvents).toHaveLength(4);
    expect(activityEvents.map((event: any) => event.entity_row_version)).toEqual([
      timestampScaleSequence,
      timestampScaleSequence + 1,
      timestampScaleSequence + 2,
      timestampScaleSequence + 3,
    ]);
    expect(activityEvents.at(-1).payload).toMatchObject({
      turn_id: base.turn_id,
      agent_activity: { turn_id: base.turn_id, state: 'completed', created_at: lifecycleCreatedAt },
    });
    expect(activityEvents.at(-1).refetch.route).toContain('/agent-activities?');
    const zeroCursor = Buffer.from(JSON.stringify({ version: 1, rowVersion: 0 }), 'utf8').toString('base64url');
    const streamPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/events/stream?cursor=${encodeURIComponent(zeroCursor)}&limit=200`;
    const stream = await app.request(streamPath, { method: 'GET', headers: { Authorization: authHeader(streamPath, 'GET', ownerSecret) } });
    const streamPreview = await readSsePreview(stream, (text) => text.includes('flightdeck_pg.agent_activity.snapshot'));
    expect(streamPreview).toContain('event: flightdeck_pg.event');
    expect(streamPreview).toContain('flightdeck_pg.agent_activity.snapshot');
    expect(streamPreview).toContain(activityId);
    expect(streamPreview).toContain(base.turn_id);

    const [activityAudit] = await sql<{ turn_id: string | null }[]>`
      SELECT metadata->>'turn_id' AS turn_id
      FROM flightdeck_pg_audit_events
      WHERE workspace_id = ${workspaceId}
        AND action = 'agent_activity.upsert'
        AND resource_id = ${created.json.agent_activity.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(activityAudit.turn_id).toBe(base.turn_id);

    // Runtime migration leaves pre-contract rows nullable. Their next valid
    // higher-sequence write claims turn identity once, after which it is immutable.
    await sql`
      UPDATE flightdeck_pg_agent_activities
      SET turn_id = NULL, terminal_at = NULL, state = 'working', expires_at = NOW() + INTERVAL '5 minutes'
      WHERE workspace_id = ${workspaceId} AND activity_id = ${activityId}
    `;
    const legacyBackfill = await requestJson(activityPath, 'PUT', agentSecret, {
      ...base,
      state: 'working',
      sequence: timestampScaleSequence + 4,
      summary: 'Recovered legacy row',
    });
    expect(legacyBackfill.res.status).toBe(200);
    expect(legacyBackfill.json.agent_activity).toMatchObject({ turn_id: base.turn_id, sequence: timestampScaleSequence + 4 });

    const otherActivityId = 'session-activity-2';
    const otherTurn = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/agent-activities/${otherActivityId}`, 'PUT', agentSecret, {
      ...base,
      activity_id: undefined,
      turn_id: 'turn-activity-2',
      state: 'working',
      sequence: timestampScaleSequence + 1,
      summary: 'Separate turn',
      body: 'This belongs only to turn two.',
    });
    expect(otherTurn.res.status).toBe(201);
    const otherHydrated = await requestJson(`${hydratePath}&activity_id=${otherActivityId}`, 'GET', ownerSecret);
    expect(otherHydrated.json.agent_activities).toHaveLength(1);
    expect(otherHydrated.json.agent_activities[0].commentary_history).toEqual([
      expect.objectContaining({ turn_id: 'turn-activity-2', activity_id: otherActivityId, sequence: timestampScaleSequence + 1, body: 'This belongs only to turn two.' }),
    ]);

    await sql`UPDATE flightdeck_pg_agent_activities SET expires_at = NOW() - INTERVAL '1 second' WHERE workspace_id = ${workspaceId} AND activity_id = ${activityId}`;
    const expired = await requestJson(`${hydratePath}&activity_id=${activityId}`, 'GET', ownerSecret);
    expect(expired.res.status).toBe(200);
    expect(expired.json.agent_activities).toEqual([]);
    const [{ count: expiredCommentaryCount }] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_agent_activity_commentary
      WHERE workspace_id = ${workspaceId} AND activity_id = ${activityId}
    `;
    expect(expiredCommentaryCount).toBe('0');
  });

  test('allows any permitted actor kind to publish activity with a matching signer', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpghumandirectactivity');
    const humanAgentMember = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, {
      member_npub: HUMAN_DIRECT_CHAT_AGENT_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'Agent',
    });
    expect(humanAgentMember.res.status).toBe(201);
    expect(humanAgentMember.json.actor.kind).toBe('human');

    const scope = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, { name: 'Direct Activity', kind: 'project' });
    const channel = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scope.json.scope.id}/channels`, 'POST', ownerSecret, {
      name: 'Direct Chat',
      kind: 'channel',
    });
    expect(channel.res.status).toBe(201);
    const channelId = channel.json.channel.id as string;
    const triggerBody = 'Show live progress';
    const trigger = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/messages`, 'POST', ownerSecret, {
      body: triggerBody,
      create_thread: true,
      message_signature: messageSignature({ body: triggerBody, secret: ownerSecret, workspaceId, channelId }),
    });
    expect(trigger.res.status).toBe(201);
    const activityPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/agent-activities/human-direct-activity`;
    const body = {
      channel_id: channelId,
      thread_id: trigger.json.thread.id,
      trigger_message_id: trigger.json.message.id,
      turn_id: 'human-direct-turn',
      session_id: 'human-direct-session',
      agent_npub: HUMAN_DIRECT_CHAT_AGENT_NPUB,
      state: 'working',
      visibility: 'user_visible',
      sequence: 0,
    };

    const noPermission = await requestJson(activityPath, 'PUT', humanDirectChatAgentSecret, body);
    expect(noPermission.res.status).toBe(403);
    const grant = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/grants`, 'POST', ownerSecret, {
      principal_type: 'actor',
      principal_id: humanAgentMember.json.actor.actor_id,
      access_level: 'contribute',
    });
    expect(grant.res.status).toBe(201);

    const signerMismatch = await requestJson(activityPath, 'PUT', humanDirectChatAgentSecret, { ...body, agent_npub: AGENT_NPUB });
    expect(signerMismatch.res.status).toBe(400);
    expect(signerMismatch.json.details.fields).toContainEqual(expect.objectContaining({ path: 'agent_npub', code: 'mismatch' }));

    const created = await requestJson(activityPath, 'PUT', humanDirectChatAgentSecret, body);
    expect(created.res.status).toBe(201);
    expect(created.json.agent_activity).toMatchObject({ agent_npub: HUMAN_DIRECT_CHAT_AGENT_NPUB, state: 'working' });
    const [canonicalActor] = await sql<{ kind: string }[]>`
      SELECT kind FROM flightdeck_pg_actors WHERE id = ${humanAgentMember.json.actor.actor_id}
    `;
    expect(canonicalActor.kind).toBe('human');
  });

  test('moves tasks and documents atomically across scopes with permission and history checks', async () => {
    const { workspaceId, groupMemberId } = await seedWorkspace('npub1workspaceflightdeckpgmoves');
    const scopesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`;
    const sourceScope = await requestJson(scopesPath, 'POST', ownerSecret, { name: 'Move Source', kind: 'project' });
    const destinationScope = await requestJson(scopesPath, 'POST', ownerSecret, { name: 'Move Destination', kind: 'project' });
    expect(sourceScope.res.status).toBe(201);
    expect(destinationScope.res.status).toBe(201);
    const sourceScopeId = sourceScope.json.scope.id as string;
    const destinationScopeId = destinationScope.json.scope.id as string;
    const sourceChannel = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${sourceScopeId}/channels`, 'POST', ownerSecret, { name: 'Intake', type: 'tasks' });
    const destinationChannel = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${destinationScopeId}/channels`, 'POST', ownerSecret, { name: 'Delivery', type: 'tasks' });
    const staleDestinationChannel = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${destinationScopeId}/channels`, 'POST', ownerSecret, { name: 'Alternate', type: 'tasks' });
    const sourceChannelId = sourceChannel.json.channel.id as string;
    const destinationChannelId = destinationChannel.json.channel.id as string;
    const staleDestinationChannelId = staleDestinationChannel.json.channel.id as string;

    const taskCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${sourceChannelId}/tasks`, 'POST', ownerSecret, { title: 'Move this task', description: 'Identity and comments survive.' });
    expect(taskCreate.res.status).toBe(201);
    const taskId = taskCreate.json.task.id as string;
    const taskComment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/comments`, 'POST', ownerSecret, { body: 'Keep this task comment.' });
    const taskAssignment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/assignments`, 'POST', ownerSecret, { actor_id: groupMemberId });
    expect(taskComment.res.status).toBe(201);
    expect(taskAssignment.res.status).toBe(201);

    const taskMovePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/move`;
    const deniedTaskMove = await requestJson(taskMovePath, 'POST', groupMemberSecret, { destination_channel_id: destinationChannelId, destination_scope_id: destinationScopeId });
    expect(deniedTaskMove.res.status).toBe(403);
    expect(deniedTaskMove.json.required_permission).toBe('task.read');
    const invalidTaskMove = await requestJson(taskMovePath, 'POST', ownerSecret, { destination_channel_id: crypto.randomUUID(), destination_scope_id: destinationScopeId });
    expect(invalidTaskMove.res.status).toBe(404);
    expect(invalidTaskMove.json.code).toBe('destination_channel_not_found');

    const movedTask = await requestJson(taskMovePath, 'POST', ownerSecret, { destination_channel_id: destinationChannelId, destination_scope_id: destinationScopeId, row_version: taskCreate.json.task.row_version });
    expect(movedTask.res.status).toBe(200);
    expect(movedTask.json.task).toMatchObject({ id: taskId, scope_id: destinationScopeId, channel_id: destinationChannelId, title: 'Move this task' });
    expect(movedTask.json.task.assignments).toHaveLength(1);
    expect(movedTask.json.audit.operation).toBe('task.move');
    expect(movedTask.json.outbox.destination.row_version).toBeGreaterThan(movedTask.json.outbox.source.row_version);
    const sourceTasks = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${sourceChannelId}/tasks`, 'GET', ownerSecret);
    const destinationTasks = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${destinationChannelId}/tasks`, 'GET', ownerSecret);
    expect(sourceTasks.json.tasks.map((task: any) => task.id)).not.toContain(taskId);
    expect(destinationTasks.json.tasks.map((task: any) => task.id)).toContain(taskId);
    const movedTaskComments = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/comments`, 'GET', ownerSecret);
    expect(movedTaskComments.json.comments[0]).toMatchObject({ id: taskComment.json.comment.id, scope_id: destinationScopeId, channel_id: destinationChannelId, body: 'Keep this task comment.' });
    const duplicateTaskMove = await requestJson(taskMovePath, 'POST', ownerSecret, { destination_channel_id: destinationChannelId });
    expect(duplicateTaskMove.res.status).toBe(409);
    expect(duplicateTaskMove.json.code).toBe('same_destination');
    const staleTaskMove = await requestJson(taskMovePath, 'POST', ownerSecret, { destination_channel_id: staleDestinationChannelId, row_version: taskCreate.json.task.row_version });
    expect(staleTaskMove.res.status).toBe(409);
    expect(staleTaskMove.json.code).toBe('stale_row_version');

    const [workspaceOwner] = await sql<{ workspace_owner_npub: string }[]>`SELECT workspace_owner_npub FROM flightdeck_pg_workspaces WHERE id = ${workspaceId}`;
    const [docStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, file_name, content_type, size_bytes, storage_path)
      VALUES (${workspaceOwner.workspace_owner_npub}, ${OWNER_NPUB}, 'move-doc.md', 'text/markdown', 24, 'v4/flightdeck-pg/api/move-doc.md')
      RETURNING id
    `;
    const docCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${sourceChannelId}/docs`, 'POST', ownerSecret, { title: 'Move this document', summary: 'Body link must follow.', storage_object_id: docStorageObject.id });
    expect(docCreate.res.status).toBe(201);
    const docId = docCreate.json.doc.id as string;
    const docComment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/comments`, 'POST', ownerSecret, { body: 'Keep this document comment.' });
    expect(docComment.res.status).toBe(201);
    const docMovePath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/move`;
    const movedDoc = await requestJson(docMovePath, 'POST', ownerSecret, { destination_channel_id: destinationChannelId, destination_scope_id: destinationScopeId, row_version: docCreate.json.doc.row_version });
    expect(movedDoc.res.status).toBe(200);
    expect(movedDoc.json.doc).toMatchObject({ id: docId, scope_id: destinationScopeId, channel_id: destinationChannelId, storage_object_id: docStorageObject.id, title: 'Move this document' });
    expect(movedDoc.json.audit.operation).toBe('doc.move');
    const movedDocRead = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}`, 'GET', ownerSecret);
    expect(movedDocRead.res.status).toBe(200);
    expect(movedDocRead.json.doc.body.storage_object.object_id).toBe(docStorageObject.id);
    const movedDocComments = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/comments`, 'GET', ownerSecret);
    expect(movedDocComments.json.comments[0]).toMatchObject({ id: docComment.json.comment.id, scope_id: destinationScopeId, channel_id: destinationChannelId, body: 'Keep this document comment.' });
    const docVersions = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}/versions`, 'GET', ownerSecret);
    expect(docVersions.json.versions[0]).toMatchObject({ doc_id: docId, scope_id: destinationScopeId, channel_id: destinationChannelId });
    const sourceDocs = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${sourceChannelId}/docs`, 'GET', ownerSecret);
    const destinationDocs = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${destinationChannelId}/docs`, 'GET', ownerSecret);
    expect(sourceDocs.json.docs.map((doc: any) => doc.id)).not.toContain(docId);
    expect(destinationDocs.json.docs.map((doc: any) => doc.id)).toContain(docId);
    const duplicateDocMove = await requestJson(docMovePath, 'POST', ownerSecret, { destination_channel_id: destinationChannelId });
    expect(duplicateDocMove.res.status).toBe(409);
    expect(duplicateDocMove.json.code).toBe('same_destination');
  });

  test('exposes a replay-safe task agent trigger contract', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgtasktriggers');
    const agentMember = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'POST', ownerSecret, {
      member_npub: AGENT_NPUB,
      role: 'member',
      kind: 'agent',
      display_name: 'automation-agent',
    });
    expect(agentMember.res.status).toBe(201);
    const scope = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, { name: 'Task triggers', kind: 'project' });
    const channel = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scope.json.scope.id}/channels`, 'POST', ownerSecret, { name: 'Agent tasks', type: 'tasks' });
    const channelId = channel.json.channel.id as string;
    const agentGrant = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/grants`, 'POST', ownerSecret, {
      principal_type: 'actor',
      principal_id: agentMember.json.actor.actor_id,
      access_level: 'contribute',
    });
    expect(agentGrant.res.status).toBe(201);
    const mention = { type: 'agent', npub: AGENT_NPUB, label: 'automation-agent' };
    const created = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/tasks`, 'POST', ownerSecret, {
      title: 'Unified task session',
      description: 'Please progress this task, automation-agent.',
      mentions: [mention],
    });
    expect(created.res.status).toBe(201);
    const taskId = created.json.task.id as string;
    const canonicalMention = { type: 'agent', actor_id: agentMember.json.actor.actor_id, npub: AGENT_NPUB, label: 'automation-agent' };
    expect(created.json.task.metadata.mentions).toEqual([canonicalMention]);

    const updated = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}`, 'PATCH', ownerSecret, {
      description: 'Updated instructions for automation-agent.',
      metadata: { mentions: [mention], origin: 'contract-test' },
    });
    expect(updated.res.status).toBe(200);
    expect(updated.json.task.metadata).toMatchObject({ mentions: [canonicalMention], origin: 'contract-test' });

    const assigned = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/assignments`, 'POST', ownerSecret, { actor_id: agentMember.json.actor.actor_id });
    expect(assigned.res.status).toBe(201);
    expect(assigned.json.outbox).toEqual(expect.objectContaining({ id: expect.any(String), row_version: expect.any(Number) }));
    const replayedAssignment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/assignments`, 'POST', ownerSecret, { actor_id: agentMember.json.actor.actor_id });
    expect(replayedAssignment.res.status).toBe(200);
    expect(replayedAssignment.json).toMatchObject({ changed: false, outbox: null });

    const comment = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/comments`, 'POST', ownerSecret, {
      body: 'automation-agent, please inspect the latest change.',
      metadata: { mentions: [mention], source: 'human' },
    });
    expect(comment.res.status).toBe(201);
    expect(comment.json.comment).toMatchObject({ workspace_id: workspaceId, scope_id: scope.json.scope.id, channel_id: channelId, task_id: taskId, metadata: { mentions: [canonicalMention], source: 'human' }, row_version: 1, created_by_actor_npub: OWNER_NPUB });

    const listedComments = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${taskId}/comments`, 'GET', agentSecret);
    expect(listedComments.res.status).toBe(200);
    expect(listedComments.json.comments[0]).toMatchObject({ id: comment.json.comment.id, metadata: { mentions: [canonicalMention] }, created_by_actor_npub: OWNER_NPUB });

    const events = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=200`, 'GET', agentSecret);
    expect(events.res.status).toBe(200);
    const taskEvents = events.json.events.filter((event: any) => event.payload?.task_id === taskId);
    expect(taskEvents.every((event: any) => event.event_id === event.id && typeof event.cursor === 'string' && event.entity_row_version >= 1)).toBe(true);
    const updateEvent = taskEvents.find((event: any) => event.event_type === 'flightdeck_pg.task.updated');
    expect(updateEvent.payload).toMatchObject({ task: { id: taskId, channel_id: channelId }, mentions: { previous: [canonicalMention], current: [canonicalMention] }, author: { actor_npub: OWNER_NPUB, signer_npub: OWNER_NPUB } });
    const assignmentEvent = taskEvents.find((event: any) => event.event_type === 'flightdeck_pg.task_assignment.assigned');
    expect(assignmentEvent.payload).toMatchObject({ assignee: { actor_id: agentMember.json.actor.actor_id, actor_npub: AGENT_NPUB }, transition: { previous: 'absent', current: 'present' } });
    const commentEvent = taskEvents.find((event: any) => event.event_type === 'flightdeck_pg.task_comment.created');
    expect(commentEvent.payload).toMatchObject({ comment: { id: comment.json.comment.id, task_id: taskId, metadata: { mentions: [canonicalMention] }, created_by_actor_npub: OWNER_NPUB }, mentions: [canonicalMention] });
  });

  test('creates, starts, searches, links, appends, and archives native workrooms', async () => {
    const { workspaceId, groupMemberId, ownerId } = await seedWorkspace('npub1workspaceflightdeckpgworkrooms');
    const scopeCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, {
      name: 'Build Room Scope',
      kind: 'project',
    });
    expect(scopeCreate.res.status).toBe(201);
    const scopeId = scopeCreate.json.scope.id as string;
    const channelCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`, 'POST', ownerSecret, {
      name: 'Workroom Channel',
      kind: 'channel',
    });
    expect(channelCreate.res.status).toBe(201);
    const channelId = channelCreate.json.channel.id as string;
    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id, principal_type, principal_actor_id, resource_type, resource_scope_id, resource_channel_id, permission, created_by_actor_id
      )
      VALUES
        (${workspaceId}, 'actor', ${groupMemberId}, 'channel', ${scopeId}, ${channelId}, 'channel.read', ${ownerId}),
        (${workspaceId}, 'actor', ${groupMemberId}, 'channel', ${scopeId}, ${channelId}, 'channel.write', ${ownerId})
    `;

    const ordinaryThread = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads`, 'POST', ownerSecret, {
      title: 'Ordinary chat thread',
    });
    expect(ordinaryThread.res.status).toBe(201);
    const ordinaryContext = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads/${ordinaryThread.json.thread.id}/workroom-context`, 'GET', ownerSecret);
    expect(ordinaryContext.res.status).toBe(200);
    expect(ordinaryContext.json.isWorkroom).toBe(false);

    const create = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms`, 'POST', ownerSecret, {
      channel_id: channelId,
      title: 'Multiplayer Flight Deck',
      goal: 'Build native workrooms',
      integration_autopilot_npub: 'npub1integratorworkroomtest',
      repo: { provider: 'github', owner: 'example', name: 'wingman' },
      branches: { integration: 'main', production: 'production' },
      app_targets: { preview: { url_mode: 'generated', label: 'Preview', runbook: { test: 'bun test', start: 'managed-app' } } },
      approval_policy: { merge_to_production_requires_human: true, human_approver_npubs: [OWNER_NPUB] },
      participants: [
        {
          actor_npub: OWNER_NPUB,
          kind: 'human',
          role: 'human_approver',
          metadata: {
            capabilities: ['tests'],
            localWorkspace: { repoPath: '/tmp/wingman', defaultBranch: 'main', canRunTests: true },
            constraints: { canMergeProduction: true },
          },
        },
        { actor_npub: 'npub1missingworkroomparticipant', kind: 'agent', role: 'contributor' },
      ],
    });
    expect(create.res.status).toBe(201);
    expect(create.json.workroom.status).toBe('draft');
    expect(create.json.participants.some((participant: any) => participant.access_status === 'failed')).toBe(true);
    const workroomId = create.json.workroom.id as string;
    const failedParticipant = create.json.participants.find((participant: any) => participant.access_status === 'failed');

    const participantUpdate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/participants/${failedParticipant.id}`, 'PATCH', ownerSecret, {
      status: 'inactive',
      access_status: 'failed',
      access_issue: 'manual_review_required',
    });
    expect(participantUpdate.res.status).toBe(200);
    expect(participantUpdate.json.participant.status).toBe('inactive');
    expect(participantUpdate.json.participant.access_issue).toBe('manual_review_required');

    const list = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms?channel_id=${channelId}`, 'GET', ownerSecret);
    expect(list.res.status).toBe(200);
    expect(list.json.workrooms.map((workroom: any) => workroom.id)).toContain(workroomId);

    const search = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/search?q=multiplayer`, 'GET', ownerSecret);
    expect(search.res.status).toBe(200);
    expect(search.json.workrooms.map((workroom: any) => workroom.id)).toContain(workroomId);

    const event = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/events`, 'POST', ownerSecret, {
      event_type: 'note',
      title: 'Ready for route test',
      body: 'Append-only event',
    });
    expect(event.res.status).toBe(201);
    expect(event.json.event.event_type).toBe('note');

    const link = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/links`, 'POST', ownerSecret, {
      link_type: 'preview_url',
      target_type: 'preview',
      external_url: 'https://preview.example.invalid',
      label: 'Preview',
    });
    expect(link.res.status).toBe(201);
    expect(link.json.link.external_url).toBe('https://preview.example.invalid');

    const approvalRequest = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/approvals`, 'POST', ownerSecret, {
      action: 'production_merge',
      title: 'Merge production',
      metadata: {
        repo: 'example-org/wingman',
        from_branch: 'main',
        to_branch: 'production',
        commit: 'abc123',
        preview_url: 'https://preview.example.invalid',
      },
    });
    expect(approvalRequest.res.status).toBe(201);
    const approvalId = approvalRequest.json.approval.id as string;

    const nonApproverDecision = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/approvals/${approvalId}/decision`, 'POST', groupMemberSecret, {
      status: 'approved',
      row_version: approvalRequest.json.approval.row_version,
    });
    expect(nonApproverDecision.res.status).toBe(403);
    expect(nonApproverDecision.json.code).toBe('approval_approver_required');

    const wrongCommitGuard = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/production-merge/check`, 'POST', ownerSecret, {
      repo: 'example-org/wingman',
      to_branch: 'production',
      commit: 'wrong',
    });
    expect(wrongCommitGuard.res.status).toBe(409);

    const ownerDecision = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/approvals/${approvalId}/decision`, 'POST', ownerSecret, {
      status: 'approved',
      row_version: approvalRequest.json.approval.row_version,
      decision_note: 'Approved by owner',
    });
    expect(ownerDecision.res.status).toBe(200);
    expect(ownerDecision.json.approval.status).toBe('approved');

    const mergeGuard = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/production-merge/check`, 'POST', ownerSecret, {
      repo: 'example-org/wingman',
      to_branch: 'production',
      commit: 'abc123',
    });
    expect(mergeGuard.res.status).toBe(200);
    expect(mergeGuard.json.approved).toBe(true);

    const start = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/start`, 'POST', ownerSecret, {
      row_version: create.json.workroom.row_version,
    });
    expect(start.res.status).toBe(200);
    expect(start.json.workroom.status).toBe('active');
    expect(start.json.announcement_message.body).toBe(`Workroom Started: ${create.json.workroom.title}, by ${OWNER_NPUB}.\nGoal: ${create.json.workroom.goal}`);
    expect(start.json.announcement_message.body).not.toContain('/api/v4/flightdeck-pg');
    expect(start.json.announcement_message.metadata.workroom_title).toBe(create.json.workroom.title);
    expect(start.json.announcement_message.metadata.workroom_goal).toBe(create.json.workroom.goal);
    expect(start.json.announcement_message.metadata.started_by_npub).toBe(OWNER_NPUB);
    expect(start.json.announcement_message.metadata.workroom_link).toContain(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}`);
    expect(start.json.announcement_message.thread_id).toBeTruthy();
    expect(start.json.announcement_thread.id).toBe(start.json.announcement_message.thread_id);
    expect(start.json.announcement_thread.source_message_id).toBe(start.json.announcement_message.id);
    expect(start.json.workroom.metadata.announcement_message_id).toBe(start.json.announcement_message.id);
    expect(start.json.workroom.metadata.announcement_thread_id).toBe(start.json.announcement_thread.id);
    expect(start.json.workroom.thread_id).toBe(start.json.announcement_thread.id);

    const activeContext = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads/${start.json.announcement_thread.id}/workroom-context?participant_npub=${encodeURIComponent(OWNER_NPUB)}`, 'GET', ownerSecret);
    expect(activeContext.res.status).toBe(200);
    expect(activeContext.json.isWorkroom).toBe(true);
    expect(activeContext.json.workroom.state).toBe('active');
    expect(activeContext.json.workroom.threadId).toBe(start.json.announcement_thread.id);
    expect(activeContext.json.participant.role).toBe('approver');
    expect(activeContext.json.participant.metadataStatus).toBe('valid');
    expect(activeContext.json.participant.capabilities).toEqual(['tests']);
    expect(activeContext.json.appTargets[0].kind).toBe('preview');
    expect(activeContext.json.appTargets[0].runbook).toEqual({ test: 'bun test', start: 'managed-app' });
    expect(activeContext.json.openApprovals).toHaveLength(0);

    const missingMetadataContext = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads/${start.json.announcement_thread.id}/workroom-context?participant_npub=npub1missingworkroomparticipant`, 'GET', ownerSecret);
    expect(missingMetadataContext.res.status).toBe(200);
    expect(missingMetadataContext.json.participant.metadataStatus).toBe('missing');
    expect(missingMetadataContext.json.participant.role).toBe('contributor');

    const get = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}`, 'GET', ownerSecret);
    expect(get.res.status).toBe(200);
    expect(get.json.workroom.metadata.announcement_message_id).toBe(start.json.announcement_message.id);
    expect(get.json.workroom.metadata.announcement_thread_id).toBe(start.json.announcement_thread.id);
    expect(get.json.events.map((entry: any) => entry.event_type)).toEqual(expect.arrayContaining(['created', 'started', 'note', 'access_grant_failed']));
    expect(get.json.links.map((entry: any) => entry.link_type)).toContain('preview_url');

    const archive = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/workrooms/${workroomId}/archive`, 'POST', ownerSecret, {
      row_version: start.json.workroom.row_version,
    });
    expect(archive.res.status).toBe(200);
    expect(archive.json.workroom.status).toBe('archived');
    const archivedContext = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/threads/${start.json.announcement_thread.id}/workroom-context`, 'GET', ownerSecret);
    expect(archivedContext.res.status).toBe(200);
    expect(archivedContext.json.isWorkroom).toBe(true);
    expect(archivedContext.json.workroom.state).toBe('archived');
  });

  test('branches stale document bodies into idempotent recoveries and resolves them optimistically', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspacedocrecovery');
    const scopeCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`, 'POST', ownerSecret, { name: 'Recovery Scope', kind: 'project' });
    expect(scopeCreate.res.status).toBe(201);
    const scopeId = scopeCreate.json.scope.id as string;
    const channelCreate = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`, 'POST', ownerSecret, { name: 'Recovery Docs', kind: 'channel' });
    expect(channelCreate.res.status).toBe(201);
    const channelId = channelCreate.json.channel.id as string;
    const docsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/docs`;

    const initialBody = await createCompletedDocStorageObject({ workspaceId, fileName: 'recovery-initial.md', content: '# Initial\n' });
    const docCreate = await requestJson(docsPath, 'POST', ownerSecret, { title: 'Recoverable document', storage_object_id: initialBody.id });
    expect(docCreate.res.status).toBe(201);
    const docId = docCreate.json.doc.id as string;
    const docPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/docs/${docId}`;
    const lease = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/edit-leases/acquire`, 'POST', ownerSecret, { entity_type: 'document', entity_id: docId });
    expect(lease.res.status).toBe(201);
    const leaseToken = lease.json.lease.lease_token as string;

    const acceptedBody = await createCompletedDocStorageObject({ workspaceId, fileName: 'recovery-accepted.md', content: '# Accepted head\n' });
    const accepted = await requestJson(docPath, 'PATCH', ownerSecret, {
      row_version: 1,
      base_version_id: `${docId}:1`,
      base_body_sha256_hex: initialBody.sha256Hex,
      storage_object_id: acceptedBody.id,
      lease_token: leaseToken,
      client_mutation_id: 'accepted-save-1',
    });
    expect(accepted.res.status).toBe(200);
    expect(accepted.json.doc).toMatchObject({ id: docId, row_version: 2, storage_object_id: acceptedBody.id });
    expect(accepted.json.canonical_version).toEqual({ version_id: `${docId}:2`, row_version: 2, storage_object_id: acceptedBody.id, body_sha256_hex: acceptedBody.sha256Hex, size_bytes: acceptedBody.bytes.byteLength });

    const staleBody = await createCompletedDocStorageObject({ workspaceId, fileName: 'recovery-stale.md', content: '# Stale but preserved\n' });
    const staleRequest = {
      row_version: 1,
      base_version_id: `${docId}:1`,
      base_body_sha256_hex: initialBody.sha256Hex,
      storage_object_id: staleBody.id,
      client_mutation_id: 'stale-save-1',
    };
    const stale = await requestJson(docPath, 'PATCH', ownerSecret, staleRequest);
    expect(stale.res.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'document_recovery_created', canonical_advanced: false, idempotent_replay: false, current_head: { row_version: 2, body_sha256_hex: acceptedBody.sha256Hex }, recovery: { reason_code: 'stale_base', resolution_state: 'open', submitted_body: { storage_object_id: staleBody.id, body_sha256_hex: staleBody.sha256Hex } } });
    const staleRecoveryId = stale.json.recovery.id as string;
    const staleRetry = await requestJson(docPath, 'PATCH', ownerSecret, { ...staleRequest, client_mutation_id: 'stale-save-retry-2' });
    expect(staleRetry.res.status).toBe(409);
    expect(staleRetry.json).toMatchObject({ idempotent_replay: true, recovery: { id: staleRecoveryId } });
    expect(staleRetry.json.audit).toBeNull();
    expect(staleRetry.json.outbox).toBeNull();

    const hashMismatchBody = await createCompletedDocStorageObject({ workspaceId, fileName: 'recovery-hash-mismatch.md', content: '# Same row, wrong base hash\n' });
    const hashMismatch = await requestJson(docPath, 'PATCH', ownerSecret, {
      row_version: 2,
      base_version_id: `${docId}:2`,
      base_body_sha256_hex: initialBody.sha256Hex,
      storage_object_id: hashMismatchBody.id,
      client_mutation_id: 'hash-mismatch-save-1',
    });
    expect(hashMismatch.res.status).toBe(409);
    expect(hashMismatch.json).toMatchObject({ canonical_advanced: false, recovery: { reason_code: 'base_body_mismatch', resolution_state: 'open', head_at_creation: { row_version: 2, body_sha256_hex: acceptedBody.sha256Hex } } });
    const hashMismatchRecoveryId = hashMismatch.json.recovery.id as string;

    const unbasedBody = await createCompletedDocStorageObject({ workspaceId, fileName: 'recovery-unbased.md', content: '# No complete base\n' });
    const unbased = await requestJson(docPath, 'PATCH', ownerSecret, {
      base_available: false,
      storage_object_id: unbasedBody.id,
      client_mutation_id: 'unbased-save-1',
    });
    expect(unbased.res.status).toBe(409);
    expect(unbased.json).toMatchObject({ canonical_advanced: false, recovery: { reason_code: 'base_unavailable', resolution_state: 'open', base: null } });
    const unbasedRecoveryId = unbased.json.recovery.id as string;

    const [canonicalAfterRecoveries] = await sql<{ row_version: number; storage_object_id: string }[]>`SELECT row_version, storage_object_id FROM flightdeck_pg_docs WHERE id = ${docId}`;
    expect(canonicalAfterRecoveries).toEqual({ row_version: 2, storage_object_id: acceptedBody.id });
    const recoveriesPath = `${docPath}/recoveries`;
    const recoveryList = await requestJson(recoveriesPath, 'GET', ownerSecret);
    expect(recoveryList.res.status).toBe(200);
    expect(recoveryList.json.recoveries.map((entry: any) => entry.id)).toEqual(expect.arrayContaining([staleRecoveryId, hashMismatchRecoveryId, unbasedRecoveryId]));
    expect((await requestJson(recoveriesPath, 'GET', groupMemberSecret)).res.status).toBe(403);
    const recoveryRead = await requestJson(`${recoveriesPath}/${staleRecoveryId}`, 'GET', ownerSecret);
    expect(recoveryRead.res.status).toBe(200);
    expect(recoveryRead.json.current_head).toMatchObject({ row_version: 2, body_sha256_hex: acceptedBody.sha256Hex });
    expect((await requestJson(`${recoveriesPath}/${staleRecoveryId}`, 'GET', groupMemberSecret)).res.status).toBe(403);
    const recoveryBody = await requestJson(`${recoveriesPath}/${staleRecoveryId}/body`, 'GET', ownerSecret);
    expect(recoveryBody.res.status).toBe(200);
    expect(recoveryBody.json.body).toMatchObject({ object_id: staleBody.id, sha256_hex: staleBody.sha256Hex, content: '# Stale but preserved\n' });
    expect((await requestJson(`${recoveriesPath}/${staleRecoveryId}/body`, 'GET', groupMemberSecret)).res.status).toBe(403);

    const stalePromotion = await requestJson(`${recoveriesPath}/${staleRecoveryId}/promote`, 'POST', ownerSecret, { row_version: 1, base_version_id: `${docId}:1`, base_body_sha256_hex: initialBody.sha256Hex, lease_token: leaseToken });
    expect(stalePromotion.res.status).toBe(409);
    expect(stalePromotion.json).toMatchObject({ code: 'recovery_promotion_conflict', current_head: { row_version: 2, body_sha256_hex: acceptedBody.sha256Hex } });
    const promoted = await requestJson(`${recoveriesPath}/${staleRecoveryId}/promote`, 'POST', ownerSecret, { row_version: 2, base_version_id: `${docId}:2`, base_body_sha256_hex: acceptedBody.sha256Hex, lease_token: leaseToken });
    expect(promoted.res.status).toBe(200);
    expect(promoted.json).toMatchObject({ doc: { row_version: 3, storage_object_id: staleBody.id }, canonical_version: { version_id: `${docId}:3`, body_sha256_hex: staleBody.sha256Hex }, recovery: { id: staleRecoveryId, resolution_state: 'promoted' } });
    const promotedRetry = await requestJson(`${recoveriesPath}/${staleRecoveryId}/promote`, 'POST', ownerSecret, { row_version: 2, base_version_id: `${docId}:2`, base_body_sha256_hex: acceptedBody.sha256Hex, lease_token: leaseToken });
    expect(promotedRetry.res.status).toBe(200);
    expect(promotedRetry.json).toMatchObject({ idempotent_replay: true, recovery: { id: staleRecoveryId, resolution_state: 'promoted' } });

    const discarded = await requestJson(`${recoveriesPath}/${unbasedRecoveryId}/discard`, 'POST', ownerSecret, {});
    expect(discarded.res.status).toBe(200);
    expect(discarded.json).toMatchObject({ idempotent_replay: false, recovery: { id: unbasedRecoveryId, resolution_state: 'discarded' } });
    const discardRetry = await requestJson(`${recoveriesPath}/${unbasedRecoveryId}/discard`, 'POST', ownerSecret, {});
    expect(discardRetry.res.status).toBe(200);
    expect(discardRetry.json).toMatchObject({ idempotent_replay: true, recovery: { resolution_state: 'discarded' } });

    const versions = await requestJson(`${docPath}/versions`, 'GET', ownerSecret);
    expect(versions.res.status).toBe(200);
    expect(versions.json.versions.map((version: any) => ({ row: version.row_version, object: version.storage_object_id }))).toEqual([
      { row: 3, object: staleBody.id },
      { row: 2, object: acceptedBody.id },
      { row: 1, object: initialBody.id },
    ]);
    const [evidence] = await sql<{ recovery_count: string; recovery_created_events: string; canonical_update_events: string; active_links: string }[]>`
      SELECT
        (SELECT COUNT(*)::text FROM flightdeck_pg_doc_recovery_versions WHERE workspace_id = ${workspaceId} AND doc_id = ${docId}) AS recovery_count,
        (SELECT COUNT(*)::text FROM flightdeck_pg_outbox_events WHERE workspace_id = ${workspaceId} AND entity_id = ${docId} AND event_type = 'flightdeck_pg.doc.recovery_created') AS recovery_created_events,
        (SELECT COUNT(*)::text FROM flightdeck_pg_outbox_events WHERE workspace_id = ${workspaceId} AND entity_id = ${docId} AND event_type = 'flightdeck_pg.doc.updated') AS canonical_update_events,
        (SELECT COUNT(*)::text FROM flightdeck_pg_storage_links WHERE workspace_id = ${workspaceId} AND entity_type = 'doc' AND entity_id = ${docId} AND deleted_at IS NULL) AS active_links
    `;
    expect(evidence).toEqual({ recovery_count: '3', recovery_created_events: '3', canonical_update_events: '1', active_links: '5' });
  }, 20_000);

  test('workspace managers can permanently delete one PG workspace with explicit confirmation', async () => {
    const { workspaceId } = await seedWorkspace('npub1workspaceflightdeckpgselfdelete');
    const path = `/api/v4/flightdeck-pg/workspaces/${workspaceId}`;

    const denied = await requestJson(path, 'DELETE', groupMemberSecret, { confirmation: workspaceId });
    expect(denied.res.status).toBe(403);

    const mismatch = await requestJson(path, 'DELETE', ownerSecret, { confirmation: 'wrong-workspace' });
    expect(mismatch.res.status).toBe(400);

    const deleted = await requestJson(path, 'DELETE', ownerSecret, { confirmation: workspaceId });
    expect(deleted.res.status).toBe(200);
    expect(deleted.json).toMatchObject({ workspace_id: workspaceId, deleted: true });
    expect(deleted.json.revoked_member_npubs).toEqual(expect.arrayContaining([OWNER_NPUB, GROUP_MEMBER_NPUB]));

    const [workspace] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_workspaces WHERE id = ${workspaceId}
    `;
    expect(workspace).toBeUndefined();
    const [membership] = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM flightdeck_pg_workspace_memberships WHERE workspace_id = ${workspaceId}
    `;
    expect(membership).toBeUndefined();
  });

  test('admin workspace listing, inspect, and delete cover PG-only workspaces', async () => {
    const setupPath = '/api/v4/admin/flightdeck-pg/workspaces';
    const wsA = await requestJson(setupPath, 'POST', adminSecret, {
      workspace_name: 'Admin PG Listing A',
      workspace_service_npub: 'npub1adminpglistinga',
      creator_npub: ADMIN_NPUB,
    });
    const wsB = await requestJson(setupPath, 'POST', adminSecret, {
      workspace_name: 'Admin PG Listing B',
      workspace_service_npub: 'npub1adminpglistingb',
      creator_npub: ADMIN_NPUB,
    });
    expect(wsA.res.status).toBe(200);
    expect(wsB.res.status).toBe(200);
    const wsAId = wsA.json.workspace_id as string;
    const wsBId = wsB.json.workspace_id as string;

    const listing = await requestJson('/api/v4/admin/workspaces', 'GET', adminSecret);
    expect(listing.res.status).toBe(200);
    const listedA = listing.json.workspaces.find((entry: any) => entry.workspace_id === wsAId);
    const listedB = listing.json.workspaces.find((entry: any) => entry.workspace_id === wsBId);
    expect(listedA?.backend).toBe('flightdeck_pg');
    expect(listedB?.backend).toBe('flightdeck_pg');

    const inspect = await requestJson(`/api/v4/admin/workspaces/${wsAId}/inspect?limit=50`, 'GET', adminSecret);
    expect(inspect.res.status).toBe(200);
    expect(inspect.json.workspace.backend).toBe('flightdeck_pg');
    expect(inspect.json.pg.members.length).toBeGreaterThan(0);
    expect(inspect.json.pg.counts.flightdeck_pg_channels).toBe(0);
    expect(inspect.json.pg.counts.flightdeck_pg_scopes).toBeGreaterThan(0);

    const preview = await requestJson('/api/v4/admin/workspaces/delete-preview', 'POST', adminSecret, {
      workspace_ids: [wsBId],
    });
    expect(preview.res.status).toBe(200);
    expect(preview.json.workspaces[0].before.flightdeck_pg_workspaces).toBe(1);

    const deleted = await requestJson(`/api/v4/admin/workspaces/${wsBId}`, 'DELETE', adminSecret, {
      confirmation: ADMIN_NPUB,
    });
    expect(deleted.res.status).toBe(200);

    // Deleting one PG workspace must not sweep sibling PG workspaces owned
    // by the same npub.
    const [siblingRow] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_workspaces WHERE id = ${wsAId}
    `;
    expect(siblingRow?.id).toBe(wsAId);
    const [deletedRow] = await sql<{ id: string }[]>`
      SELECT id FROM flightdeck_pg_workspaces WHERE id = ${wsBId}
    `;
    expect(deletedRow).toBeUndefined();
  });
});
