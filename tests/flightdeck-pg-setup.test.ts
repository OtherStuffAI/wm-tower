import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { authorizeFlightDeckPgOperation, resolveOrCreateFlightDeckPgActor } from '../src/services/flightdeck-pg-authorization';
import { createFlightDeckPgWorkspaceMember, listVisibleFlightDeckPgChannels, listVisibleFlightDeckPgScopes } from '../src/services/flightdeck-pg-api';
import { expandFlightDeckPgAccessLevel, setupFlightDeckPgDevWorkspace } from '../src/services/flightdeck-pg-setup';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_setup';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
const adminSecret = new Uint8Array(32).fill(41);
const ADMIN_NPUB = nip19.npubEncode(getPublicKey(adminSecret));
const originalAdminNpub = config.adminNpub;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function testNpub(label: string): string {
  return nip19.npubEncode(sha256Hex(label));
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

async function requestJson(path: string, method: 'POST', body: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: authHeader(path, method, adminSecret, body),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { res, json };
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

async function runMigrations() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
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
  await runMigrations();
  config.adminNpub = ADMIN_NPUB;
  app = createApp();
});

afterAll(async () => {
  config.adminNpub = originalAdminNpub;
  await closeDb();
});

describe('Flight Deck PG setup workspace bootstrap', () => {
  test('is idempotent for default group bootstrap and prints descriptor-compatible fields', async () => {
    const input = {
      towerServiceNpub: testNpub('fdpg-setup-tower'),
      workspaceServiceNpub: testNpub('fdpg-setup-workspace'),
      workspaceOwnerNpub: testNpub('fdpg-setup-owner'),
      appNpub: testNpub('fdpg-setup-app'),
      creatorNpub: testNpub('fdpg-setup-creator'),
      workspaceName: 'Flight Deck PG Setup Test',
      towerBaseUrl: 'http://localhost:3100',
    };

    const first = await setupFlightDeckPgDevWorkspace(input, sql);
    const second = await setupFlightDeckPgDevWorkspace(input, sql);

    expect(second.workspace_id).toBe(first.workspace_id);
    expect(second.descriptor_route).toBe(`/api/v4/flightdeck-pg/workspaces/${first.workspace_id}/descriptor`);
    expect(second.descriptor.identity.workspace_id).toBe(first.workspace_id);
    expect(second.descriptor.identity.tower_service_npub).toBe(input.towerServiceNpub);
    expect(second.descriptor.identity.workspace_service_npub).toBe(input.workspaceServiceNpub);
    expect(second.descriptor.identity.app_npub).toBe(input.appNpub);
    expect(second.groups.Admins).toBe(first.groups.Admins);
    expect(second.groups.Agents).toBe(first.groups.Agents);
    expect(second.groups.People).toBe(first.groups.People);
    expect(second.groups.Workspace).toBe(first.groups.Workspace);
    expect(second.smoke.scope_id).toBeNull();
    expect(second.smoke.channel_id).toBeNull();
    expect(second.channels).toEqual({});

    const [groups] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_groups
      WHERE workspace_id = ${first.workspace_id}
        AND name IN ('Admins', 'Agents', 'People', 'Workspace')
    `;
    expect(Number(groups.count)).toBe(4);

    const [creatorWorkspaceMembership] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_group_memberships
      WHERE workspace_id = ${first.workspace_id}
        AND group_id = ${first.groups.Workspace}
        AND actor_id = ${first.actors.creator.actor_id}
    `;
    expect(Number(creatorWorkspaceMembership.count)).toBe(1);

    const payload = JSON.stringify(second).toLowerCase();
    expect(payload).not.toContain('bearer');
    expect(payload).not.toContain('token');
    expect(payload).not.toContain('password');
    expect(payload).not.toContain('credential');
    expect(payload).not.toContain('nsec');
    expect(payload).not.toContain('private_key');
  });

  test('new workspace members are automatically assigned to Workspace group', async () => {
    const setup = await setupFlightDeckPgDevWorkspace({
      towerServiceNpub: testNpub('fdpg-setup-tower-2'),
      workspaceServiceNpub: testNpub('fdpg-setup-workspace-2'),
      workspaceOwnerNpub: testNpub('fdpg-setup-owner-2'),
      appNpub: testNpub('fdpg-setup-app-2'),
      creatorNpub: testNpub('fdpg-setup-creator-2'),
      workspaceName: 'Flight Deck PG Setup Access Test',
      smokeScopeName: 'Smoke Access',
      smokeChannelName: 'Smoke Channel',
    }, sql);
    const { actor: workspaceOnly } = await createFlightDeckPgWorkspaceMember({
      workspaceId: setup.workspace_id,
      actorNpub: testNpub('fdpg-setup-workspace-only'),
      role: 'member',
      kind: 'human',
      createdByActorId: setup.actors.creator.actor_id,
    }, sql);

    const [workspaceGroupMembership] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_group_memberships
      WHERE workspace_id = ${setup.workspace_id}
        AND group_id = ${setup.groups.Workspace}
        AND actor_id = ${workspaceOnly.id}
    `;
    expect(Number(workspaceGroupMembership.count)).toBe(1);

    const channels = await listVisibleFlightDeckPgChannels({
      workspaceId: setup.workspace_id,
      scopeId: setup.smoke.scope_id,
      actorId: workspaceOnly.id,
      groupIds: [setup.groups.Workspace],
      limit: 20,
    }, sql);
    expect(channels.map((channel) => channel.id)).toContain(setup.smoke.channel_id);

    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: workspaceOnly.npub,
      appNpub: setup.app_npub,
      workspaceId: setup.workspace_id,
      permission: 'channel.read',
      resource: { type: 'channel', channelId: setup.smoke.channel_id },
    }, sql);
    expect(decision.allowed).toBe(true);
  });

  test('access levels expand to canonical channel permission bundles', () => {
    expect(expandFlightDeckPgAccessLevel('view')).toEqual([
      'channel.read',
      'task.read',
      'doc.read',
      'file.read',
      'audio_note.read',
    ]);
    expect(expandFlightDeckPgAccessLevel('contribute')).toEqual([
      'channel.read',
      'task.read',
      'doc.read',
      'file.read',
      'audio_note.read',
      'channel.write',
      'task.create',
      'task.update',
      'task.comment',
      'comment.create',
      'doc.write',
      'file.write',
      'audio_note.write',
    ]);
    expect(expandFlightDeckPgAccessLevel('manage')).toEqual([
      'channel.read',
      'task.read',
      'doc.read',
      'file.read',
      'audio_note.read',
      'channel.write',
      'task.create',
      'task.update',
      'task.comment',
      'comment.create',
      'doc.write',
      'file.write',
      'audio_note.write',
      'channel.manage',
      'channel.grants.read',
      'channel.grants.manage',
    ]);
  });

  test('optional second actor receives access only through the smoke channel grant', async () => {
    const setup = await setupFlightDeckPgDevWorkspace({
      towerServiceNpub: testNpub('fdpg-setup-tower-3'),
      workspaceServiceNpub: testNpub('fdpg-setup-workspace-3'),
      workspaceOwnerNpub: testNpub('fdpg-setup-owner-3'),
      appNpub: testNpub('fdpg-setup-app-3'),
      creatorNpub: testNpub('fdpg-setup-creator-3'),
      secondActorNpub: testNpub('fdpg-setup-second-3'),
      secondActorDisplayName: 'Second Test Actor',
      workspaceName: 'Flight Deck PG Setup Second Actor Test',
      smokeScopeName: 'Smoke Second Actor',
      smokeChannelName: 'Smoke Channel',
    }, sql);
    expect(setup.actors.second_actor?.smoke_channel_id).toBe(setup.smoke.channel_id);
    expect(setup.actors.second_actor?.group_name).toBe('Workspace');

    const [sibling] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${setup.workspace_id}, ${setup.smoke.scope_id}, 'sibling', 'channel', ${setup.actors.creator.actor_id})
      RETURNING id
    `;

    const channels = await listVisibleFlightDeckPgChannels({
      workspaceId: setup.workspace_id,
      scopeId: setup.smoke.scope_id,
      actorId: setup.actors.second_actor!.actor_id,
      groupIds: [setup.groups.Workspace],
      limit: 20,
    }, sql);
    const ids = channels.map((channel) => channel.id);
    expect(ids).toContain(setup.smoke.channel_id);
    expect(ids).not.toContain(sibling.id);
  });

  test('workspace bootstrap seeds the suite scope, three channels, and an AI agent', async () => {
    const creatorNpub = 'npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul';
    const agentNpub = 'npub1f49ke5fkzqev4x7j46uajq92f4zan6kcpty5yvm5c3g6wf2dqanqn7qsy2';
    const setup = await setupFlightDeckPgDevWorkspace({
      towerServiceNpub: testNpub('fdpg-wingmen-bootstrap-tower'),
      workspaceOwnerNpub: creatorNpub,
      appNpub: config.flightDeck.appNpub,
      creatorNpub,
      creatorDisplayName: 'Workspace Owner',
      workspaceName: 'Wingmen',
      workspaceDescription: 'Wingmen Community PG dogfood workspace',
      smokeScopeName: 'Wingman Suite',
      smokeChannelName: 'Flight Deck PG',
      channelNames: ['Flight Deck PG', 'Tower PG', 'Implementation'],
      secondActorNpub: agentNpub,
      secondActorDisplayName: 'Test Agent',
      secondActorKind: 'agent',
      secondActorRole: 'agent',
      secondActorGroupName: 'Agents',
      towerBaseUrl: 'http://localhost:3100',
    }, sql);

    expect(setup.workspace_owner_npub).toBe(creatorNpub);
    expect(setup.actors.creator.membership_role).toBe('owner');
    expect(setup.actors.second_actor?.npub).toBe(agentNpub);
    expect(setup.actors.second_actor?.membership_role).toBe('agent');
    expect(setup.actors.second_actor?.group_name).toBe('Agents');
    expect(Object.keys(setup.channels).sort()).toEqual(['Flight Deck PG', 'Implementation', 'Tower PG']);
    expect(setup.smoke.channel_id).toBe(setup.channels['Flight Deck PG']);
    expect(setup.descriptor.label).toBe('Wingmen');
    expect(setup.descriptor.identity.workspace_owner_npub).toBe(creatorNpub);

    const [scope] = await sql<{ name: string }[]>`
      SELECT name FROM flightdeck_pg_scopes WHERE id = ${setup.smoke.scope_id}
    `;
    expect(scope.name).toBe('Wingman Suite');

    const agentChannels = await listVisibleFlightDeckPgChannels({
      workspaceId: setup.workspace_id,
      scopeId: setup.smoke.scope_id,
      actorId: setup.actors.second_actor!.actor_id,
      groupIds: [setup.groups.Agents],
      limit: 20,
    }, sql);
    expect(agentChannels.map((channel) => channel.name).sort()).toEqual(['Flight Deck PG', 'Implementation', 'Tower PG']);

    const agentScopes = await listVisibleFlightDeckPgScopes({
      workspaceId: setup.workspace_id,
      actorId: setup.actors.second_actor!.actor_id,
      groupIds: [setup.groups.Workspace, setup.groups.Agents],
      limit: 20,
    }, sql);
    expect(agentScopes.some((visibleScope) => visibleScope.name === 'DMs' && visibleScope.kind === 'dm')).toBe(true);

    const canCreateTask = await authorizeFlightDeckPgOperation({
      actorNpub: agentNpub,
      appNpub: setup.app_npub,
      workspaceId: setup.workspace_id,
      permission: 'task.create',
      resource: { type: 'channel', channelId: setup.channels.Implementation },
    }, sql);
    expect(canCreateTask.allowed).toBe(true);

    const aiCanCreateScope = await authorizeFlightDeckPgOperation({
      actorNpub: agentNpub,
      appNpub: setup.app_npub,
      workspaceId: setup.workspace_id,
      permission: 'scope.create',
      resource: { type: 'workspace' },
    }, sql);
    expect(aiCanCreateScope.allowed).toBe(false);

    const aiCanCreateChannel = await authorizeFlightDeckPgOperation({
      actorNpub: agentNpub,
      appNpub: setup.app_npub,
      workspaceId: setup.workspace_id,
      permission: 'channel.create',
      resource: { type: 'scope', scopeId: setup.smoke.scope_id },
    }, sql);
    expect(aiCanCreateChannel.allowed).toBe(false);

    const canWriteDoc = await authorizeFlightDeckPgOperation({
      actorNpub: creatorNpub,
      appNpub: setup.app_npub,
      workspaceId: setup.workspace_id,
      permission: 'doc.write',
      resource: { type: 'channel', channelId: setup.channels['Tower PG'] },
    }, sql);
    expect(canWriteDoc.allowed).toBe(true);
  });

  test('admin setup API creates an idempotent credential-free workspace descriptor without starter content by default', async () => {
    const path = '/api/v4/admin/flightdeck-pg/workspaces';
    const body = {
      workspace_name: 'Tower Admin Setup Workspace',
      workspace_description: 'Created from table viewer setup',
      creator_npub: ADMIN_NPUB,
    };

    const first = await requestJson(path, 'POST', body);
    const second = await requestJson(path, 'POST', body);

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.json.workspace_id).toBe(first.json.workspace_id);
    expect(second.json.viewer).toBe(ADMIN_NPUB);
    expect(second.json.descriptor_route).toBe(`/api/v4/flightdeck-pg/workspaces/${first.json.workspace_id}/descriptor`);
    expect(second.json.descriptor.type).toBe('wingman_workspace_locator');
    expect(second.json.descriptor.identity.workspace_id).toBe(first.json.workspace_id);
    expect(second.json.descriptor.identity.workspace_owner_npub).toBe(ADMIN_NPUB);
    expect(second.json.descriptor.identity.app_npub).toBe(config.flightDeck.appNpub);
    expect(second.json.descriptor.tower_base_url).toBe('http://localhost');
    expect(second.json.groups.Admins).toBeDefined();
    expect(second.json.groups.Agents).toBeDefined();
    expect(second.json.groups.People).toBeDefined();
    expect(second.json.groups.Workspace).toBeDefined();
    expect(second.json.smoke.scope_id).toBeNull();
    expect(second.json.smoke.channel_id).toBeNull();
    expect(second.json.channels).toEqual({});

    const [starterRows] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_scopes s
      LEFT JOIN flightdeck_pg_channels c ON c.scope_id = s.id
      WHERE s.workspace_id = ${second.json.workspace_id}
        AND (s.name = 'Marketing' OR c.name = 'Website')
    `;
    expect(Number(starterRows.count)).toBe(0);

    const payload = JSON.stringify(second.json.descriptor).toLowerCase();
    expect(payload).not.toContain('bearer');
    expect(payload).not.toContain('token');
    expect(payload).not.toContain('password');
    expect(payload).not.toContain('credential');
    expect(payload).not.toContain('nsec');
    expect(payload).not.toContain('private_key');
    expect(payload).not.toContain('encrypted');
  });

  test('admin setup API creates explicit smoke records when requested', async () => {
    const path = '/api/v4/admin/flightdeck-pg/workspaces';
    const body = {
      workspace_name: 'Tower Admin Smoke Setup Workspace',
      workspace_description: 'Created from table viewer setup',
      creator_npub: ADMIN_NPUB,
      smoke_scope_name: 'Marketing',
      smoke_channel_name: 'Website',
    };

    const first = await requestJson(path, 'POST', body);
    const second = await requestJson(path, 'POST', body);

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(second.json.workspace_id).toBe(first.json.workspace_id);

    const [scope] = await sql<{ name: string }[]>`
      SELECT name FROM flightdeck_pg_scopes WHERE id = ${second.json.smoke.scope_id}
    `;
    const [channel] = await sql<{ name: string }[]>`
      SELECT name FROM flightdeck_pg_channels WHERE id = ${second.json.smoke.channel_id}
    `;
    expect(scope.name).toBe('Marketing');
    expect(channel.name).toBe('Website');

    const decision = await authorizeFlightDeckPgOperation({
      actorNpub: ADMIN_NPUB,
      appNpub: config.flightDeck.appNpub,
      workspaceId: second.json.workspace_id,
      permission: 'task.create',
      resource: { type: 'channel', channelId: second.json.smoke.channel_id },
    }, sql);
    expect(decision.allowed).toBe(true);
  });
});
