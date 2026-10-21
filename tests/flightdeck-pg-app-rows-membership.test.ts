import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { AppDbError, createWorkspaceAppRow } from '../src/services/app-db';

// Regression: Flight Deck PG workspace-scoped app-row routes must authorize
// against flightdeck_pg_workspace_memberships, not the legacy v4 group model.
// Members here exist only in the PG membership tables.

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_app_rows_membership';

const ownerSecret = new Uint8Array(32).fill(81);
const memberSecret = new Uint8Array(32).fill(82);
const peerSecret = new Uint8Array(32).fill(83);
const outsiderSecret = new Uint8Array(32).fill(84);
const nbrowserSecret = new Uint8Array(32).fill(85);
const sharedAppSecret = new Uint8Array(32).fill(86);
const workspaceASecret = new Uint8Array(32).fill(87);
const workspaceBSecret = new Uint8Array(32).fill(88);
const legacyMemberSecret = new Uint8Array(32).fill(89);

const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const PEER = nip19.npubEncode(getPublicKey(peerSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));
const LEGACY_MEMBER = nip19.npubEncode(getPublicKey(legacyMemberSecret));
const NBROWSER_APP_NPUB = nip19.npubEncode(getPublicKey(nbrowserSecret));
const SHARED_APP_NPUB = nip19.npubEncode(getPublicKey(sharedAppSecret));
const WORKSPACE_A_OWNER = nip19.npubEncode(getPublicKey(workspaceASecret));
const WORKSPACE_B_OWNER = nip19.npubEncode(getPublicKey(workspaceBSecret));

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let workspaceAId = '';
let workspaceBId = '';
let legacyGroupId = '';
const actorIds = new Map<string, string>();

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function authHeader(path: string, method: string, secret: Uint8Array, body?: unknown) {
  const tags = [
    ['u', `http://localhost${path}`],
    ['method', method.toUpperCase()],
  ];
  if (body !== undefined) tags.push(['payload', sha256Hex(JSON.stringify(body))]);
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

async function requestJson(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  secret: Uint8Array,
  body?: unknown,
) {
  const response = await app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: authHeader(path, method, secret, body),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

async function runMigrations() {
  const here = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(here, '../src/schema/001_init.sql'), 'utf8');
  for (const statement of splitSqlStatements(migration)) await sql.unsafe(statement);
}

async function registerApp(workspaceOwnerNpub: string, appNpub: string, name: string, capabilities: string[]) {
  await sql`
    INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, capabilities, created_by_npub)
    VALUES (${workspaceOwnerNpub}, ${appNpub}, ${name}, true, ${sql.json(capabilities)}, ${OWNER})
  `;
}

async function seedPgOnlyWorkspace(input: { workspaceOwnerNpub: string; name: string; members: Array<[string, string]> }) {
  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      created_by_actor_id
    ) VALUES (
      'npub1towerpgapprowsmembershiptest',
      ${input.workspaceOwnerNpub},
      ${input.workspaceOwnerNpub},
      'npub1flightdeckpgapprowsmembershiptest',
      ${input.name},
      ${actorIds.get(OWNER)!}
    )
    RETURNING id
  `;
  for (const [npub, role] of input.members) {
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${actorIds.get(npub)!}, ${role}, ${actorIds.get(OWNER)!})
    `;
  }
  return workspace.id;
}

function rowsPath(workspaceId: string, appNpub: string, collection = 'settings-backups') {
  return `/api/v4/flightdeck-pg/workspaces/${workspaceId}/apps/${encodeURIComponent(appNpub)}/db/${collection}/rows`;
}

beforeAll(async () => {
  const adminOptions: Parameters<typeof postgres>[0] = {
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOptions.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOptions.password = process.env.DB_PASSWORD;
  const admin = postgres(adminOptions);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }

  sql = postgres({ ...adminOptions, database: TEST_DB });
  setDb(sql);
  await runMigrations();

  const actors = await sql<{ id: string; npub: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES
      (${OWNER}, 'human', 'Workspace owner'),
      (${MEMBER}, 'human', 'PG-only member'),
      (${PEER}, 'human', 'PG-only peer'),
      (${OUTSIDER}, 'human', 'Outsider'),
      (${LEGACY_MEMBER}, 'human', 'Legacy-only member')
    RETURNING id, npub
  `;
  for (const actor of actors) actorIds.set(actor.npub, actor.id);

  // No v4_workspaces / v4_group_members rows for the PG members: this is the
  // real PG-only shape that previously failed with workspace_forbidden.
  workspaceAId = await seedPgOnlyWorkspace({
    workspaceOwnerNpub: WORKSPACE_A_OWNER,
    name: 'PG Workspace A',
    members: [[OWNER, 'owner'], [MEMBER, 'member'], [PEER, 'member']],
  });
  workspaceBId = await seedPgOnlyWorkspace({
    workspaceOwnerNpub: WORKSPACE_B_OWNER,
    name: 'PG Workspace B',
    members: [[OWNER, 'owner'], [PEER, 'member']],
  });
  await registerApp(WORKSPACE_A_OWNER, NBROWSER_APP_NPUB, 'NBrowser', ['storage.private', 'app_rows.private_only']);
  await registerApp(WORKSPACE_B_OWNER, NBROWSER_APP_NPUB, 'NBrowser', ['storage.private', 'app_rows.private_only']);
  await registerApp(WORKSPACE_A_OWNER, SHARED_APP_NPUB, 'Shared app', []);

  // A legacy-only group under workspace A's owner npub, containing a user who
  // is not a PG member. Used to prove group/workspace audiences stay legacy.
  const [legacyGroup] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
    VALUES (${WORKSPACE_A_OWNER}, 'Legacy members', ${`${WORKSPACE_A_OWNER}-legacy-group`}, 'workspace_shared')
    RETURNING id
  `;
  legacyGroupId = legacyGroup.id;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${legacyGroupId}, ${LEGACY_MEMBER})
  `;

  app = createApp();
});

afterAll(async () => {
  await closeDb();
});

describe('Flight Deck PG app rows authorize against PG workspace membership', () => {
  test('PG-only member can create, list, read, update and delete a private NBrowser settings row', async () => {
    const path = rowsPath(workspaceAId, NBROWSER_APP_NPUB);
    const created = await requestJson(path, 'POST', memberSecret, {
      row_id: 'current-v1',
      visibility: 'private',
      data: { workspace_id: workspaceAId, status: 'complete', schema_version: 1 },
    });
    expect(created.response.status).toBe(201);
    expect(created.json.workspace_id).toBe(workspaceAId);
    expect(created.json.workspace_owner_npub).toBe(WORKSPACE_A_OWNER);
    expect(created.json.row.owner_npub).toBe(MEMBER);
    expect(created.json.row.visibility).toBe('private');

    const listed = await requestJson(path, 'GET', memberSecret);
    expect(listed.response.status).toBe(200);
    expect(listed.json.rows.map((row: { row_id: string }) => row.row_id)).toEqual(['current-v1']);

    const rowPath = `${path}/current-v1`;
    const read = await requestJson(rowPath, 'GET', memberSecret);
    expect(read.response.status).toBe(200);
    expect(read.json.row.data.status).toBe('complete');

    const updated = await requestJson(rowPath, 'PATCH', memberSecret, {
      data: { workspace_id: workspaceAId, status: 'verified', schema_version: 1 },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.json.row.data.status).toBe('verified');

    const deleted = await requestJson(rowPath, 'DELETE', memberSecret);
    expect(deleted.response.status).toBe(200);
    expect(deleted.json.deleted).toBe(true);
    const afterDelete = await requestJson(rowPath, 'GET', memberSecret);
    expect(afterDelete.response.status).toBe(404);
  });

  test('PG-only peer cannot read or mutate another member\'s private row', async () => {
    const path = rowsPath(workspaceAId, NBROWSER_APP_NPUB);
    const created = await requestJson(path, 'POST', memberSecret, { row_id: 'peer-check', visibility: 'private', data: {} });
    expect(created.response.status).toBe(201);
    const rowPath = `${path}/peer-check`;

    const peerList = await requestJson(path, 'GET', peerSecret);
    expect(peerList.response.status).toBe(200);
    expect(peerList.json.rows).toEqual([]);
    expect((await requestJson(rowPath, 'GET', peerSecret)).response.status).toBe(404);
    expect((await requestJson(rowPath, 'PATCH', peerSecret, { data: { forged: true } })).response.status).toBe(404);
    expect((await requestJson(rowPath, 'DELETE', peerSecret)).response.status).toBe(404);

    const forgedOwner = await requestJson(path, 'POST', peerSecret, {
      row_id: 'forged-owner',
      owner_npub: MEMBER,
      visibility: 'private',
      data: {},
    });
    expect(forgedOwner.response.status).toBe(403);
    expect(forgedOwner.json.code).toBe('owner_forbidden');

    const stillMine = await requestJson(rowPath, 'GET', memberSecret);
    expect(stillMine.response.status).toBe(200);
    expect(stillMine.json.row.data).toEqual({});
  });

  test('outsider and legacy-only users are forbidden on PG-scoped rows', async () => {
    const path = rowsPath(workspaceAId, NBROWSER_APP_NPUB);
    for (const secret of [outsiderSecret, legacyMemberSecret]) {
      const list = await requestJson(path, 'GET', secret);
      expect(list.response.status).toBe(403);
      expect(list.json.code).toBe('workspace_membership_required');
      const create = await requestJson(path, 'POST', secret, { row_id: 'intruder', visibility: 'private', data: {} });
      expect(create.response.status).toBe(403);
      expect(create.json.code).toBe('workspace_membership_required');
    }
  });

  test('workspace isolation: rows stay in their workspace and non-members of B are forbidden there', async () => {
    const pathA = rowsPath(workspaceAId, NBROWSER_APP_NPUB);
    const pathB = rowsPath(workspaceBId, NBROWSER_APP_NPUB);

    const memberInB = await requestJson(pathB, 'GET', memberSecret);
    expect(memberInB.response.status).toBe(403);
    expect(memberInB.json.code).toBe('workspace_membership_required');

    const peerInA = await requestJson(pathA, 'POST', peerSecret, { row_id: 'peer-a', visibility: 'private', data: { ws: 'a' } });
    expect(peerInA.response.status).toBe(201);
    const peerInB = await requestJson(pathB, 'POST', peerSecret, { row_id: 'peer-b', visibility: 'private', data: { ws: 'b' } });
    expect(peerInB.response.status).toBe(201);
    expect(peerInB.json.workspace_owner_npub).toBe(WORKSPACE_B_OWNER);

    const listA = await requestJson(pathA, 'GET', peerSecret);
    expect(listA.json.rows.map((row: { row_id: string }) => row.row_id)).toEqual(['peer-a']);
    const listB = await requestJson(pathB, 'GET', peerSecret);
    expect(listB.json.rows.map((row: { row_id: string }) => row.row_id)).toEqual(['peer-b']);
    expect((await requestJson(`${pathB}/peer-a`, 'GET', peerSecret)).response.status).toBe(404);
  });

  test('service rejects PG authority whose workspace does not map to the addressed owner npub', async () => {
    let error: unknown = null;
    try {
      await createWorkspaceAppRow(
        WORKSPACE_B_OWNER,
        NBROWSER_APP_NPUB,
        'settings-backups',
        { row_id: 'cross-workspace', visibility: 'private', data: {} },
        MEMBER,
        { authority: 'flightdeck_pg_membership', flightdeckPgWorkspaceId: workspaceAId, actorId: actorIds.get(MEMBER)! },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppDbError);
    expect((error as AppDbError).code).toBe('workspace_forbidden');

    let actorMismatch: unknown = null;
    try {
      await createWorkspaceAppRow(
        WORKSPACE_A_OWNER,
        NBROWSER_APP_NPUB,
        'settings-backups',
        { row_id: 'actor-mismatch', visibility: 'private', data: {} },
        OUTSIDER,
        { authority: 'flightdeck_pg_membership', flightdeckPgWorkspaceId: workspaceAId, actorId: actorIds.get(MEMBER)! },
      );
    } catch (caught) {
      actorMismatch = caught;
    }
    expect(actorMismatch).toBeInstanceOf(AppDbError);
    expect((actorMismatch as AppDbError).code).toBe('workspace_forbidden');
  });

  test('group and workspace visibility audiences stay on the legacy model', async () => {
    const path = rowsPath(workspaceAId, SHARED_APP_NPUB, 'notes');

    const privateRow = await requestJson(path, 'POST', memberSecret, { row_id: 'private-note', visibility: 'private', data: {} });
    expect(privateRow.response.status).toBe(201);

    const workspaceRow = await requestJson(path, 'POST', memberSecret, { row_id: 'shared-note', visibility: 'workspace', data: {} });
    expect(workspaceRow.response.status).toBe(403);
    expect(workspaceRow.json.code).toBe('workspace_forbidden');

    const groupRow = await requestJson(path, 'POST', memberSecret, {
      row_id: 'group-note',
      visibility: 'group',
      group_id: legacyGroupId,
      data: {},
    });
    expect(groupRow.response.status).toBe(403);
    expect(groupRow.json.code).toBe('group_forbidden');

    const promote = await requestJson(`${path}/private-note`, 'PATCH', memberSecret, { visibility: 'workspace' });
    expect(promote.response.status).toBe(403);
    expect(promote.json.code).toBe('workspace_forbidden');

    // A legacy-only member's workspace-visible row is not exposed to PG-only members.
    await sql`
      INSERT INTO workspace_app_rows (
        workspace_owner_npub, app_npub, collection, row_id, owner_npub, visibility, data, created_by_npub, updated_by_npub
      ) VALUES (
        ${WORKSPACE_A_OWNER}, ${SHARED_APP_NPUB}, 'notes', 'legacy-shared', ${LEGACY_MEMBER}, 'workspace', '{}'::jsonb, ${LEGACY_MEMBER}, ${LEGACY_MEMBER}
      )
    `;
    const memberList = await requestJson(path, 'GET', memberSecret);
    expect(memberList.response.status).toBe(200);
    expect(memberList.json.rows.map((row: { row_id: string }) => row.row_id)).toEqual(['private-note']);
    expect((await requestJson(`${path}/legacy-shared`, 'PATCH', memberSecret, { data: { forged: true } })).response.status).toBe(404);
    expect((await requestJson(`${path}/legacy-shared`, 'DELETE', memberSecret)).response.status).toBe(404);
  });

  test('legacy owner-npub app-row route still requires legacy membership', async () => {
    const path = `/api/v4/workspaces/${encodeURIComponent(WORKSPACE_A_OWNER)}/apps/${encodeURIComponent(NBROWSER_APP_NPUB)}/db/settings-backups/rows`;
    const pgOnly = await requestJson(path, 'GET', memberSecret);
    expect(pgOnly.response.status).toBe(403);
    expect(pgOnly.json.code).toBe('workspace_forbidden');
  });

  test('revoking PG membership revokes PG-scoped row access', async () => {
    const path = rowsPath(workspaceAId, NBROWSER_APP_NPUB);
    await sql`
      DELETE FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceAId}
        AND actor_id = ${actorIds.get(MEMBER)!}
    `;
    const revoked = await requestJson(path, 'GET', memberSecret);
    expect(revoked.response.status).toBe(403);
    expect(revoked.json.code).toBe('workspace_membership_required');
  });
});
