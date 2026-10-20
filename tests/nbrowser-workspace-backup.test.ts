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
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest } from '../src/services/storage';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_nbrowser_workspace_backup';

const ownerSecret = new Uint8Array(32).fill(71);
const memberSecret = new Uint8Array(32).fill(72);
const peerSecret = new Uint8Array(32).fill(73);
const outsiderSecret = new Uint8Array(32).fill(74);
const namespaceSecret = new Uint8Array(32).fill(75);
const workspaceASecret = new Uint8Array(32).fill(76);
const workspaceBSecret = new Uint8Array(32).fill(77);

const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const PEER = nip19.npubEncode(getPublicKey(peerSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));
const NBROWSER_APP_NPUB = nip19.npubEncode(getPublicKey(namespaceSecret));
const WORKSPACE_A_OWNER = nip19.npubEncode(getPublicKey(workspaceASecret));
const WORKSPACE_B_OWNER = nip19.npubEncode(getPublicKey(workspaceBSecret));

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let workspaceAId = '';
let workspaceBId = '';
let memberActorId = '';

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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

async function seedWorkspace(input: {
  workspaceOwnerNpub: string;
  name: string;
  includeNamespace: boolean;
}) {
  const [legacyGroup] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
    VALUES (${input.workspaceOwnerNpub}, ${`${input.name} members`}, ${`${input.workspaceOwnerNpub}-group`}, 'workspace_shared')
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
    VALUES (${legacyGroup.id}, 1, ${`${input.workspaceOwnerNpub}-group`}, ${OWNER})
  `;
  const [legacyWorkspace] = await sql<{ id: string }[]>`
    INSERT INTO v4_workspaces (
      workspace_owner_npub,
      creator_npub,
      name,
      wrapped_workspace_nsec,
      wrapped_by_npub,
      default_group_id
    ) VALUES (
      ${input.workspaceOwnerNpub},
      ${OWNER},
      ${input.name},
      'ciphertext-only-test-fixture',
      ${OWNER},
      ${legacyGroup.id}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${legacyGroup.id}, ${OWNER}), (${legacyGroup.id}, ${MEMBER}), (${legacyGroup.id}, ${PEER})
  `;

  const actors = await sql<{ id: string; npub: string }[]>`
    SELECT id, npub FROM flightdeck_pg_actors WHERE npub IN (${OWNER}, ${MEMBER}, ${PEER})
  `;
  const ownerActor = actors.find((actor) => actor.npub === OWNER)!;
  const memberActor = actors.find((actor) => actor.npub === MEMBER)!;
  const peerActor = actors.find((actor) => actor.npub === PEER)!;
  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      description,
      created_by_actor_id,
      v4_workspace_id
    ) VALUES (
      'npub1towernbrowserbackuptest',
      ${input.workspaceOwnerNpub},
      ${input.workspaceOwnerNpub},
      'npub1flightdecknbrowserbackuptest',
      ${input.name},
      'NBrowswer workspace backup contract fixture',
      ${ownerActor.id},
      ${legacyWorkspace.id}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
    VALUES
      (${workspace.id}, ${ownerActor.id}, 'owner', ${ownerActor.id}),
      (${workspace.id}, ${memberActor.id}, 'member', ${ownerActor.id}),
      (${workspace.id}, ${peerActor.id}, 'member', ${ownerActor.id})
  `;
  if (input.includeNamespace) {
    await sql`
      INSERT INTO workspace_apps (
        workspace_owner_npub,
        app_npub,
        app_name,
        enabled,
        capabilities,
        created_by_npub
      ) VALUES (
        ${input.workspaceOwnerNpub},
        ${NBROWSER_APP_NPUB},
        'NBrowser',
        true,
        ${sql.json(['storage.private', 'app_rows.private_only'])},
        ${OWNER}
      )
    `;
  }
  return workspace.id;
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

  const testOptions: Parameters<typeof postgres>[0] = { ...adminOptions, database: TEST_DB };
  sql = postgres(testOptions);
  setDb(sql);
  await runMigrations();
  const actors = await sql<{ id: string; npub: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES
      (${OWNER}, 'human', 'Workspace owner'),
      (${MEMBER}, 'human', 'Backup owner'),
      (${PEER}, 'human', 'Other member'),
      (${OUTSIDER}, 'human', 'Outsider')
    RETURNING id, npub
  `;
  memberActorId = actors.find((actor) => actor.npub === MEMBER)!.id;
  workspaceAId = await seedWorkspace({ workspaceOwnerNpub: WORKSPACE_A_OWNER, name: 'Workspace A', includeNamespace: true });
  workspaceBId = await seedWorkspace({ workspaceOwnerNpub: WORKSPACE_B_OWNER, name: 'Workspace B', includeNamespace: false });
  enableInMemoryStorageForTest();
  app = createApp();
});

afterAll(async () => {
  resetInMemoryStorageForTest();
  await closeDb();
});

describe('workspace-scoped NBrowser backup contract', () => {
  test('legacy human owner_npub storage prepare reproduces the current 403', async () => {
    const path = '/api/v4/storage/prepare';
    const body = {
      owner_npub: MEMBER,
      content_type: 'application/vnd.wingman.nbrowser-settings+json',
      size_bytes: 42,
      file_name: 'nbrowser-settings.nip44',
      metadata: { purpose: 'nbrowser/settings-backup', schema_version: 1 },
    };
    const result = await requestJson(path, 'POST', memberSecret, body);
    expect(result.response.status).toBe(403);
    expect(result.json.error).toContain('does not match any workspace');
  });

  test('member stores ciphertext and private pointer in exactly one selected workspace', async () => {
    const ciphertext = new TextEncoder().encode('nip44-ciphertext-only');
    const preparePath = `/api/v4/flightdeck-pg/workspaces/${workspaceAId}/storage/prepare`;
    const prepareBody = {
      content_type: 'application/vnd.wingman.nbrowser-settings+json',
      size_bytes: ciphertext.byteLength,
      file_name: 'nbrowser-settings.nip44',
      owner_npub: WORKSPACE_B_OWNER,
      access_group_ids: ['00000000-0000-0000-0000-000000000000'],
      metadata: { purpose: 'nbrowser/settings-backup', schema_version: 1 },
    };
    const prepared = await requestJson(preparePath, 'POST', memberSecret, prepareBody);
    expect(prepared.response.status).toBe(201);
    expect(prepared.json.owner_npub).toBe(WORKSPACE_A_OWNER);
    expect(prepared.json.access_group_ids).toEqual([]);
    expect(prepared.json.is_public).toBe(false);

    const objectId = prepared.json.object_id as string;
    const uploadPath = `/api/v4/storage/${objectId}`;
    const uploaded = await requestJson(uploadPath, 'PUT', memberSecret, {
      base64_data: Buffer.from(ciphertext).toString('base64'),
    });
    expect(uploaded.response.status).toBe(200);
    const completePath = `/api/v4/storage/${objectId}/complete`;
    const completed = await requestJson(completePath, 'POST', memberSecret, {
      sha256_hex: sha256Hex(ciphertext),
      size_bytes: ciphertext.byteLength,
    });
    expect(completed.response.status).toBe(200);

    const contentPath = `/api/v4/storage/${objectId}/content`;
    const read = await app.request(contentPath, {
      headers: { Authorization: authHeader(contentPath, 'GET', memberSecret) },
    });
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(ciphertext);
    const peerRead = await app.request(contentPath, {
      headers: { Authorization: authHeader(contentPath, 'GET', peerSecret) },
    });
    expect(peerRead.status).toBe(404);

    const rowsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceAId}/apps/${encodeURIComponent(NBROWSER_APP_NPUB)}/db/settings-backups/rows`;
    const pointer = {
      row_id: 'current-v1',
      visibility: 'private',
      data: {
        workspace_id: workspaceAId,
        object_id: objectId,
        sha256_hex: sha256Hex(ciphertext),
        status: 'complete',
        schema_version: 1,
      },
    };
    const created = await requestJson(rowsPath, 'POST', memberSecret, pointer);
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get('cache-control')).toBe('private, no-store');
    expect(created.json.workspace_id).toBe(workspaceAId);
    expect(created.json.workspace_owner_npub).toBe(WORKSPACE_A_OWNER);
    expect(created.json.row.owner_npub).toBe(MEMBER);
    expect(created.json.row.visibility).toBe('private');

    const rowPath = `${rowsPath}/current-v1`;
    const ownRead = await requestJson(rowPath, 'GET', memberSecret);
    expect(ownRead.response.status).toBe(200);
    expect(ownRead.json.row.data.object_id).toBe(objectId);
    const updated = await requestJson(rowPath, 'PATCH', memberSecret, {
      data: { ...pointer.data, status: 'verified' },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.json.row.data.status).toBe('verified');
    const peerRowRead = await requestJson(rowPath, 'GET', peerSecret);
    expect(peerRowRead.response.status).toBe(404);
    const peerList = await requestJson(rowsPath, 'GET', peerSecret);
    expect(peerList.response.status).toBe(200);
    expect(peerList.json.rows).toEqual([]);

    const ownerOverride = await requestJson(rowsPath, 'POST', memberSecret, {
      row_id: 'forged-owner',
      owner_npub: PEER,
      visibility: 'private',
      data: {},
    });
    expect(ownerOverride.response.status).toBe(403);
    expect(ownerOverride.json.code).toBe('owner_forbidden');
    const sharedPointer = await requestJson(rowsPath, 'POST', memberSecret, {
      row_id: 'shared-pointer',
      visibility: 'workspace',
      data: {},
    });
    expect(sharedPointer.response.status).toBe(403);
    expect(sharedPointer.json.code).toBe('visibility_forbidden');
    const ownerAddressedRowsPath = `/api/v4/workspaces/${encodeURIComponent(WORKSPACE_A_OWNER)}/apps/${encodeURIComponent(NBROWSER_APP_NPUB)}/db/settings-backups/rows`;
    const legacySharedPointer = await requestJson(ownerAddressedRowsPath, 'POST', memberSecret, {
      row_id: 'legacy-shared-pointer',
      visibility: 'workspace',
      data: {},
    });
    expect(legacySharedPointer.response.status).toBe(403);
    expect(legacySharedPointer.json.code).toBe('visibility_forbidden');

    const outsiderPrepare = await requestJson(preparePath, 'POST', outsiderSecret, prepareBody);
    expect(outsiderPrepare.response.status).toBe(403);
    expect(outsiderPrepare.json.code).toBe('workspace_membership_required');
    const missingWorkspacePath = preparePath.replace(workspaceAId, '00000000-0000-4000-8000-000000000099');
    const missingWorkspace = await requestJson(missingWorkspacePath, 'POST', memberSecret, prepareBody);
    expect(missingWorkspace.response.status).toBe(404);
    expect(missingWorkspace.json.code).toBe('workspace_not_found');

    const wrongWorkspaceRows = rowsPath.replace(workspaceAId, workspaceBId);
    const missingNamespace = await requestJson(wrongWorkspaceRows, 'GET', memberSecret);
    expect(missingNamespace.response.status).toBe(404);
    expect(missingNamespace.json.code).toBe('app_not_found');

    const physicalProvisionPath = `/api/v4/workspaces/${encodeURIComponent(WORKSPACE_A_OWNER)}/apps/${encodeURIComponent(NBROWSER_APP_NPUB)}/db/provision`;
    const physicalProvision = await requestJson(physicalProvisionPath, 'POST', memberSecret, { app_slug: 'nbrowser' });
    expect(physicalProvision.response.status).toBe(403);
    expect(physicalProvision.json.code).toBe('app_or_admin_signer_required');

    await sql`
      UPDATE workspace_apps
      SET enabled = false
      WHERE workspace_owner_npub = ${WORKSPACE_A_OWNER}
        AND app_npub = ${NBROWSER_APP_NPUB}
    `;
    const disabledNamespace = await requestJson(rowPath, 'GET', memberSecret);
    expect(disabledNamespace.response.status).toBe(404);
    expect(disabledNamespace.json.code).toBe('app_not_found');
    await sql`
      UPDATE workspace_apps
      SET enabled = true
      WHERE workspace_owner_npub = ${WORKSPACE_A_OWNER}
        AND app_npub = ${NBROWSER_APP_NPUB}
    `;

    await sql`
      DELETE FROM flightdeck_pg_workspace_memberships
      WHERE workspace_id = ${workspaceAId}
        AND actor_id = ${memberActorId}
    `;
    const revoked = await requestJson(rowPath, 'GET', memberSecret);
    expect(revoked.response.status).toBe(403);
    expect(revoked.json.code).toBe('workspace_membership_required');
  });
});
