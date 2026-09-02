import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_workspaces';

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
  clearWsKeyCacheForTests();
  if (sql) await sql.end();
});

const ownerSecret = new Uint8Array(32).fill(9);
const memberSecret = new Uint8Array(32).fill(8);
const normalMemberSecret = new Uint8Array(32).fill(71);
const externalSecret = new Uint8Array(32).fill(72);
const workspaceKeySecret = new Uint8Array(32).fill(73);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const NORMAL_MEMBER = nip19.npubEncode(getPublicKey(normalMemberSecret));
const EXTERNAL = nip19.npubEncode(getPublicKey(externalSecret));
const NORMAL_MEMBER_WS_KEY = nip19.npubEncode(getPublicKey(workspaceKeySecret));
const ADMIN_INVITEE = 'npub1admininvitee00000000000000000000000000000000000000000';
const WORKSPACE_OWNER = 'npub1workspaceowner000000000000000000000000000000000000000000';
const LEGACY_WORKSPACE_OWNER = 'npub1legacyworkspaceowner000000000000000000000000000000000000';
const RECOVER_WORKSPACE_OWNER = 'npub1recoverworkspaceowner00000000000000000000000000000000000';

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

describe('Workspaces API', () => {
  let adminGroupId = '';

  test('POST /api/v4/workspaces creates workspace plus default and private groups', async () => {
    const payload = {
      workspace_owner_npub: WORKSPACE_OWNER,
      name: 'Winn Family',
      description: 'Family workspace',
      wrapped_workspace_nsec: 'wrapped-workspace-secret',
      wrapped_by_npub: OWNER,
      default_group_npub: 'npub1workspacegroup000000000000000000000000000000000000000000',
      default_group_name: 'Family Shared',
      default_group_member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-shared-owner', wrapped_by_npub: OWNER },
      ],
      admin_group_npub: 'npub1workspaceadmingroup00000000000000000000000000000000000000',
      admin_group_name: 'Workspace Admins',
      admin_group_member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-admin-owner', wrapped_by_npub: OWNER },
      ],
      private_group_npub: 'npub1privategroup0000000000000000000000000000000000000000000',
      private_group_name: 'Operator Private',
      private_group_member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-private-owner', wrapped_by_npub: OWNER },
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

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.name).toBe('Winn Family');
    expect(body.slug).toBe('winn-family');
    expect(body.avatar_url).toBeNull();
    expect(body.default_group_npub).toBe(payload.default_group_npub);
    expect(body.admin_group_npub).toBe(payload.admin_group_npub);
    expect(body.private_group_npub).toBe(payload.private_group_npub);
    expect(body.wrapped_workspace_nsec).toBe('wrapped-workspace-secret');
    adminGroupId = body.admin_group_id;
  });

  test('GET /api/v4/workspaces lists owned workspace for creator', async () => {
    const res = await app.request(`/api/v4/workspaces?member_npub=${encodeURIComponent(OWNER)}`, {
      headers: {
        Authorization: authHeader(`/api/v4/workspaces?member_npub=${encodeURIComponent(OWNER)}`, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.workspaces[0].slug).toBe('winn-family');
    expect(body.workspaces[0].avatar_url).toBeNull();
    expect(body.workspaces[0].admin_group_id).toBe(adminGroupId);
    expect(body.workspaces[0].private_group_npub).toBeDefined();
    expect(body.workspaces[0].wrapped_workspace_nsec).toBe('wrapped-workspace-secret');
  });

  test('GET /api/v4/workspaces backfills an admin group for legacy workspaces', async () => {
    const [legacySharedGroup] = await sql<{ id: string }[]>`
      INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
      VALUES (
        ${LEGACY_WORKSPACE_OWNER},
        ${'Legacy Shared'},
        ${'npub1legacysharedgroup00000000000000000000000000000000000000'},
        ${'workspace_shared'}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${legacySharedGroup.id}, ${OWNER})
    `;
    await sql`
      INSERT INTO v4_workspaces (
        workspace_owner_npub,
        creator_npub,
        name,
        description,
        wrapped_workspace_nsec,
        wrapped_by_npub,
        default_group_id
      ) VALUES (
        ${LEGACY_WORKSPACE_OWNER},
        ${OWNER},
        ${'Legacy Workspace'},
        ${''},
        ${'wrapped-legacy-workspace-secret'},
        ${OWNER},
        ${legacySharedGroup.id}
      )
    `;

    const res = await app.request(`/api/v4/workspaces?member_npub=${encodeURIComponent(OWNER)}`, {
      headers: {
        Authorization: authHeader(`/api/v4/workspaces?member_npub=${encodeURIComponent(OWNER)}`, 'GET', ownerSecret),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const legacyWorkspace = body.workspaces.find((entry: any) => entry.workspace_owner_npub === LEGACY_WORKSPACE_OWNER);
    expect(legacyWorkspace).toBeTruthy();
    expect(legacyWorkspace.slug).toBe('legacy-workspace');
    expect(legacyWorkspace.admin_group_id).toBeTruthy();
    expect(legacyWorkspace.admin_group_npub).toMatch(/^npub1/);

    const [adminGroup] = await sql<{ group_kind: string; member_npub: string }[]>`
      SELECT g.group_kind, gm.member_npub
      FROM v4_groups g
      JOIN v4_group_members gm ON gm.group_id = g.id
      WHERE g.id = ${legacyWorkspace.admin_group_id}
    `;
    expect(adminGroup.group_kind).toBe('workspace_admin');
    expect(adminGroup.member_npub).toBe(OWNER);
  });

  test('PATCH /api/v4/workspaces/:workspaceOwnerNpub updates workspace metadata', async () => {
    const payload = {
      name: 'Winn Family HQ',
      slug: 'family-hq',
      description: 'Updated family workspace',
      avatar_url: 'storage://workspace-avatar-1',
    };

    const res = await app.request(`/api/v4/workspaces/${encodeURIComponent(WORKSPACE_OWNER)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(`/api/v4/workspaces/${encodeURIComponent(WORKSPACE_OWNER)}`, 'PATCH', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace_owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.name).toBe(payload.name);
    expect(body.slug).toBe(payload.slug);
    expect(body.description).toBe(payload.description);
    expect(body.avatar_url).toBe(payload.avatar_url);
  });

  test('PATCH /api/v4/workspaces/:workspaceOwnerNpub rejects non-manager', async () => {
    const payload = { name: 'Nope' };

    const res = await app.request(`/api/v4/workspaces/${encodeURIComponent(WORKSPACE_OWNER)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(`/api/v4/workspaces/${encodeURIComponent(WORKSPACE_OWNER)}`, 'PATCH', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(403);
  });

  test('PATCH /api/v4/workspaces/:workspaceOwnerNpub allows workspace admin members', async () => {
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${adminGroupId}, ${MEMBER})
      ON CONFLICT (group_id, member_npub) DO NOTHING
    `;

    const payload = { description: 'Admin-updated workspace' };
    const res = await app.request(`/api/v4/workspaces/${encodeURIComponent(WORKSPACE_OWNER)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(`/api/v4/workspaces/${encodeURIComponent(WORKSPACE_OWNER)}`, 'PATCH', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe(payload.description);
    expect(body.slug).toBe('family-hq');
  });

  test('POST /api/v4/workspaces/recover attaches an admin group for recovered workspaces', async () => {
    const [recoverSharedGroup] = await sql<{ id: string }[]>`
      INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
      VALUES (
        ${RECOVER_WORKSPACE_OWNER},
        ${'Recovered Shared'},
        ${'npub1recoveredsharedgroup0000000000000000000000000000000000'},
        ${'workspace_shared'}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${recoverSharedGroup.id}, ${OWNER})
    `;

    const payload = {
      workspace_owner_npub: RECOVER_WORKSPACE_OWNER,
      name: 'Recovered Workspace',
      wrapped_workspace_nsec: 'wrapped-recovered-secret',
      wrapped_by_npub: OWNER,
    };

    const res = await app.request('/api/v4/workspaces/recover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/workspaces/recover', 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workspace_owner_npub).toBe(RECOVER_WORKSPACE_OWNER);
    expect(body.slug).toBe('recovered-workspace');
    expect(body.admin_group_id).toBeTruthy();
    expect(body.admin_group_npub).toMatch(/^npub1/);
  });

  test('GET /api/v4/workspaces rejects mismatched auth', async () => {
    const res = await app.request(`/api/v4/workspaces?member_npub=${encodeURIComponent(OWNER)}`, {
      headers: {
        Authorization: authHeader(`/api/v4/workspaces?member_npub=${encodeURIComponent(OWNER)}`, 'GET', memberSecret),
      },
    });

    expect(res.status).toBe(403);
  });

  test('POST /api/v4/groups allows workspace creator to create a workspace-owned group with their own wrapped key', async () => {
    const payload = {
      owner_npub: WORKSPACE_OWNER,
      name: 'Parents',
      group_npub: 'npub1parentsgroup000000000000000000000000000000000000000000',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-creator-key', wrapped_by_npub: OWNER },
        { member_npub: MEMBER, wrapped_group_nsec: 'wrapped-member-key', wrapped_by_npub: OWNER },
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
    expect(body.owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.name).toBe('Parents');
  });

  test('POST /api/v4/groups allows workspace admin members to create groups with external invitees', async () => {
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${adminGroupId}, ${MEMBER})
      ON CONFLICT (group_id, member_npub) DO NOTHING
    `;

    const payload = {
      owner_npub: WORKSPACE_OWNER,
      name: 'Admin Member Created',
      group_npub: 'npub1adminmembercreatedgroup000000000000000000000000000000',
      member_keys: [
        { member_npub: MEMBER, wrapped_group_nsec: 'wrapped-admin-member-key', wrapped_by_npub: MEMBER },
        { member_npub: ADMIN_INVITEE, wrapped_group_nsec: 'wrapped-admin-invitee-key', wrapped_by_npub: MEMBER },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(body.group_kind).toBe('shared');
    expect(body.members.map((member: any) => member.member_npub)).toContain(MEMBER);
    expect(body.members.map((member: any) => member.member_npub)).toContain(ADMIN_INVITEE);
  });

  test('POST /api/v4/groups allows ordinary workspace members to create normal shared groups', async () => {
    const [workspace] = await sql<{ default_group_id: string }[]>`
      SELECT default_group_id
      FROM v4_workspaces
      WHERE workspace_owner_npub = ${WORKSPACE_OWNER}
    `;
    await sql`
      INSERT INTO v4_group_members (group_id, member_npub)
      VALUES (${workspace.default_group_id}, ${NORMAL_MEMBER})
      ON CONFLICT (group_id, member_npub) DO NOTHING
    `;

    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'Member Created',
      group_npub: 'npub1membercreatedgroup000000000000000000000000000000000000',
      member_keys: [
        { member_npub: NORMAL_MEMBER, wrapped_group_nsec: 'wrapped-normal-member', wrapped_by_npub: NORMAL_MEMBER },
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-owner', wrapped_by_npub: NORMAL_MEMBER },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', normalMemberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.owner_npub).toBe(WORKSPACE_OWNER);
    expect(body.workspace_service_npub).toBe(WORKSPACE_OWNER);
    expect(body.group_kind).toBe('shared');
    expect(body.members.map((member: any) => member.member_npub)).toContain(NORMAL_MEMBER);
  });

  test('POST /api/v4/groups rejects non-members for workspace-owned groups', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'External Attempt',
      group_npub: 'npub1externalattemptgroup0000000000000000000000000000000000',
      member_keys: [
        { member_npub: EXTERNAL, wrapped_group_nsec: 'wrapped-external', wrapped_by_npub: EXTERNAL },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', externalSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(403);
  });

  test('POST /api/v4/groups requires member creators to include their own wrapped key', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'No Creator Key',
      group_npub: 'npub1nocreatorkeygroup00000000000000000000000000000000000',
      member_keys: [
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-owner', wrapped_by_npub: NORMAL_MEMBER },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', normalMemberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('group creator must have a wrapped key');
  });

  test('POST /api/v4/groups rejects duplicate member keys', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'Duplicate Keys',
      group_npub: 'npub1duplicatekeysgroup0000000000000000000000000000000000',
      member_keys: [
        { member_npub: NORMAL_MEMBER, wrapped_group_nsec: 'wrapped-one', wrapped_by_npub: NORMAL_MEMBER },
        { member_npub: NORMAL_MEMBER, wrapped_group_nsec: 'wrapped-two', wrapped_by_npub: NORMAL_MEMBER },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', normalMemberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('unique member_npub');
  });

  test('POST /api/v4/groups rejects protected system group kinds', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'Protected',
      group_npub: 'npub1protectedkindgroup00000000000000000000000000000000000',
      group_kind: 'workspace_admin',
      member_keys: [
        { member_npub: NORMAL_MEMBER, wrapped_group_nsec: 'wrapped-normal-member', wrapped_by_npub: NORMAL_MEMBER },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', normalMemberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('reserved for system-managed groups');
  });

  test('POST /api/v4/groups rejects external member keys from member-created workspace groups', async () => {
    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'External Key',
      group_npub: 'npub1externalkeygroup000000000000000000000000000000000000',
      member_keys: [
        { member_npub: NORMAL_MEMBER, wrapped_group_nsec: 'wrapped-normal-member', wrapped_by_npub: NORMAL_MEMBER },
        { member_npub: EXTERNAL, wrapped_group_nsec: 'wrapped-external', wrapped_by_npub: NORMAL_MEMBER },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', normalMemberSecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('existing workspace members');
  });

  test('POST /api/v4/groups resolves workspace session key auth to the real member creator', async () => {
    await sql`
      INSERT INTO user_profiles (user_npub)
      VALUES (${NORMAL_MEMBER})
      ON CONFLICT (user_npub) DO NOTHING
    `;
    await sql`
      INSERT INTO user_workspace_keys (user_npub, workspace_owner_npub, ws_key_npub, ws_key_epoch, active)
      VALUES (${NORMAL_MEMBER}, ${WORKSPACE_OWNER}, ${NORMAL_MEMBER_WS_KEY}, 1, true)
      ON CONFLICT (workspace_owner_npub, ws_key_npub) DO UPDATE
      SET user_npub = EXCLUDED.user_npub,
          active = true
    `;
    clearWsKeyCacheForTests();

    const payload = {
      workspace_service_npub: WORKSPACE_OWNER,
      name: 'Session Key Created',
      group_npub: 'npub1sessionkeycreatedgroup0000000000000000000000000000000',
      member_keys: [
        { member_npub: NORMAL_MEMBER, wrapped_group_nsec: 'wrapped-normal-member', wrapped_by_npub: NORMAL_MEMBER_WS_KEY },
        { member_npub: OWNER, wrapped_group_nsec: 'wrapped-owner', wrapped_by_npub: NORMAL_MEMBER_WS_KEY },
      ],
    };

    const res = await app.request('/api/v4/groups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/groups', 'POST', workspaceKeySecret, payload),
      },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.members.map((member: any) => member.member_npub)).toContain(NORMAL_MEMBER);
  });
});
