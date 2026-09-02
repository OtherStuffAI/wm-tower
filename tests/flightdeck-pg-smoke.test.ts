import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { createApp } from '../src/server';
import { enableInMemoryStorageForTest, resetInMemoryStorageForTest } from '../src/services/storage';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_smoke';
const APP_NPUB = 'npub1flightdeckpgsmokeapp';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

const operatorSecret = new Uint8Array(32).fill(61);
const collaboratorSecret = new Uint8Array(32).fill(62);
const OPERATOR_NPUB = nip19.npubEncode(getPublicKey(operatorSecret));
const COLLABORATOR_NPUB = nip19.npubEncode(getPublicKey(collaboratorSecret));

function sha256Hex(input: string | Uint8Array): string {
  return typeof input === 'string'
    ? createHash('sha256').update(input, 'utf8').digest('hex')
    : createHash('sha256').update(input).digest('hex');
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

async function requestJson(path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', secret: Uint8Array, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: authHeader(path, method, secret, body),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { res, json };
}

async function runMigrations() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

async function seedExampleWorkspace() {
  const [operator] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES (${OPERATOR_NPUB}, 'human', 'Operator')
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
      'npub1towerexamplesmoke',
      'npub1workspaceexamplesmoke',
      ${OPERATOR_NPUB},
      ${APP_NPUB},
      'Example',
      'Flight Deck PG backend smoke workspace',
      ${operator.id}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
    VALUES (${workspace.id}, ${operator.id}, 'owner', ${operator.id})
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
      (${workspace.id}, 'actor', ${operator.id}, 'workspace', 'workspace.read', ${operator.id}),
      (${workspace.id}, 'actor', ${operator.id}, 'workspace', 'workspace.manage', ${operator.id}),
      (${workspace.id}, 'actor', ${operator.id}, 'workspace', 'workspace.invite', ${operator.id}),
      (${workspace.id}, 'actor', ${operator.id}, 'workspace', 'scope.create', ${operator.id})
  `;
  return { workspaceId: workspace.id, operatorId: operator.id };
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
  enableInMemoryStorageForTest();
  app = createApp();
});

afterAll(async () => {
  resetInMemoryStorageForTest();
  await closeDb();
});

describe('Flight Deck PG backend smoke story', () => {
  test('Operator and Collaborator can work Website tasks while Blogs stays hidden from Collaborator', async () => {
    const { workspaceId, operatorId } = await seedExampleWorkspace();

    const memberPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`;
    const collaboratorMember = await requestJson(memberPath, 'POST', operatorSecret, {
      member_npub: COLLABORATOR_NPUB,
      role: 'member',
      kind: 'human',
      display_name: 'Collaborator',
    });
    expect(collaboratorMember.res.status).toBe(201);
    const collaboratorId = collaboratorMember.json.actor.actor_id as string;

    const groupsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/groups`;
    const workspaceMembers = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/members`, 'GET', operatorSecret);
    expect(workspaceMembers.res.status).toBe(200);
    expect(workspaceMembers.json.members.map((member: any) => member.actor.npub)).toContain(COLLABORATOR_NPUB);

    const avatarPrepare = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/storage/prepare`,
      'POST',
      operatorSecret,
      {
        content_type: 'image/png',
        size_bytes: 4,
        file_name: 'workspace-avatar.png',
        is_public: true,
        metadata: {
          purpose: 'workspace-profile/avatar',
          visibility: 'public',
        },
      },
    );
    expect(avatarPrepare.res.status).toBe(201);
    expect(avatarPrepare.json.is_public).toBe(true);
    expect(avatarPrepare.json.access_group_ids).toEqual([]);
    const avatarObjectId = avatarPrepare.json.object_id as string;
    const avatarBytes = new Uint8Array([137, 80, 78, 71]);
    const avatarUploadBody = { base64_data: Buffer.from(avatarBytes).toString('base64') };
    const avatarUploadPath = `/api/v4/storage/${avatarObjectId}`;
    const avatarUpload = await requestJson(avatarUploadPath, 'PUT', operatorSecret, avatarUploadBody);
    expect(avatarUpload.res.status).toBe(200);
    const avatarComplete = await requestJson(
      `/api/v4/storage/${avatarObjectId}/complete`,
      'POST',
      operatorSecret,
      { size_bytes: avatarBytes.byteLength, sha256_hex: sha256Hex(avatarBytes) },
    );
    expect(avatarComplete.res.status).toBe(200);
    const avatarSave = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}`, 'PATCH', operatorSecret, {
      name: 'Example',
      slug: 'example',
      description: 'Flight Deck PG backend smoke workspace',
      avatar_url: `storage://${avatarObjectId}`,
    });
    expect(avatarSave.res.status).toBe(200);
    expect(avatarSave.json.avatar_url).toBe(`storage://${avatarObjectId}`);
    const avatarContentPath = `/api/v4/storage/${avatarObjectId}/content`;
    const avatarMemberRead = await app.request(avatarContentPath, {
      method: 'GET',
      headers: {
        Authorization: authHeader(avatarContentPath, 'GET', collaboratorSecret),
      },
    });
    expect(avatarMemberRead.status).toBe(200);
    expect(new Uint8Array(await avatarMemberRead.arrayBuffer())).toEqual(avatarBytes);

    const parentGroup = await requestJson(groupsPath, 'POST', operatorSecret, {
      name: 'Marketing Leads',
      kind: 'custom',
    });
    expect(parentGroup.res.status).toBe(201);
    const parentGroupId = parentGroup.json.group.group_id as string;

    const childGroup = await requestJson(groupsPath, 'POST', operatorSecret, {
      name: 'Website Editors',
      kind: 'custom',
    });
    expect(childGroup.res.status).toBe(201);
    const childGroupId = childGroup.json.group.group_id as string;

    const addCollaboratorToChild = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/groups/${childGroupId}/members`,
      'POST',
      operatorSecret,
      { actor_id: collaboratorId },
    );
    expect(addCollaboratorToChild.res.status).toBe(201);
    expect(addCollaboratorToChild.json.members.map((member: any) => member.npub)).toContain(COLLABORATOR_NPUB);

    const nestedEdge = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/groups/${parentGroupId}/child-groups`,
      'POST',
      operatorSecret,
      { child_group_id: childGroupId },
    );
    expect(nestedEdge.res.status).toBe(201);

    const parentEffectiveMembers = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/groups/${parentGroupId}/effective-members`,
      'GET',
      operatorSecret,
    );
    expect(parentEffectiveMembers.res.status).toBe(200);
    expect(parentEffectiveMembers.json.effective_member_npubs).toContain(COLLABORATOR_NPUB);

    const groupList = await requestJson(groupsPath, 'GET', operatorSecret);
    expect(groupList.res.status).toBe(200);
    const listedParent = groupList.json.groups.find((group: any) => group.group_id === parentGroupId);
    expect(listedParent.child_group_ids).toContain(childGroupId);
    expect(listedParent.effective_member_npubs).toContain(COLLABORATOR_NPUB);

    const collaboratorDeniedGroupCreate = await requestJson(groupsPath, 'POST', collaboratorSecret, {
      name: 'Unauthorized group',
      kind: 'custom',
    });
    expect(collaboratorDeniedGroupCreate.res.status).toBe(403);
    expect(collaboratorDeniedGroupCreate.json.required_permission).toBe('workspace.manage');

    const scopesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes`;
    const marketingScope = await requestJson(scopesPath, 'POST', operatorSecret, {
      name: 'Marketing',
      kind: 'project',
    });
    expect(marketingScope.res.status).toBe(201);
    const scopeId = marketingScope.json.scope.id as string;

    const channelsPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/channels`;
    const websiteChannel = await requestJson(channelsPath, 'POST', operatorSecret, {
      name: 'Website',
      kind: 'channel',
    });
    expect(websiteChannel.res.status).toBe(201);
    const websiteChannelId = websiteChannel.json.channel.id as string;

    const blogsChannel = await requestJson(channelsPath, 'POST', operatorSecret, {
      name: 'Blogs',
      kind: 'channel',
    });
    expect(blogsChannel.res.status).toBe(201);
    const blogsChannelId = blogsChannel.json.channel.id as string;

    for (const channelId of [websiteChannelId, blogsChannelId]) {
      const grant = await requestJson(
        `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${channelId}/grants`,
        'POST',
        operatorSecret,
        {
          principal_type: 'actor',
          principal_id: operatorId,
          permissions: ['task.read', 'task.create', 'task.update', 'task.comment'],
        },
      );
      expect(grant.res.status).toBe(201);
    }

    const collaboratorWebsiteGrant = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${websiteChannelId}/grants`,
      'POST',
      operatorSecret,
      {
        principal_type: 'actor',
        principal_id: collaboratorId,
        permissions: ['channel.read', 'task.read', 'task.update', 'task.comment'],
      },
    );
    expect(collaboratorWebsiteGrant.res.status).toBe(201);

    const collaboratorChannels = await requestJson(channelsPath, 'GET', collaboratorSecret);
    expect(collaboratorChannels.res.status).toBe(200);
    expect(collaboratorChannels.json.channels.map((channel: any) => channel.name)).toEqual(['Website']);

    const collaboratorWebsiteChannel = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${websiteChannelId}`,
      'GET',
      collaboratorSecret,
    );
    expect(collaboratorWebsiteChannel.res.status).toBe(200);
    expect(collaboratorWebsiteChannel.json.channel.id).toBe(websiteChannelId);
    expect(collaboratorWebsiteChannel.json.channel.scope_id).toBe(scopeId);

    const collaboratorBlogsChannel = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${blogsChannelId}`,
      'GET',
      collaboratorSecret,
    );
    expect(collaboratorBlogsChannel.res.status).toBe(403);
    expect(collaboratorBlogsChannel.json.required_permission).toBe('channel.read');

    const fileFoldersPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${websiteChannelId}/file-folders`;
    const rootFolder = await requestJson(fileFoldersPath, 'POST', operatorSecret, {
      title: 'Design assets',
    });
    expect(rootFolder.res.status).toBe(201);
    expect(rootFolder.json.folder.scope_id).toBe(scopeId);
    expect(rootFolder.json.folder.channel_id).toBe(websiteChannelId);
    const rootFolderId = rootFolder.json.folder.id as string;

    const nestedFolder = await requestJson(fileFoldersPath, 'POST', operatorSecret, {
      title: 'Wireframes',
      parent_folder_id: rootFolderId,
    });
    expect(nestedFolder.res.status).toBe(201);
    expect(nestedFolder.json.folder.parent_folder_id).toBe(rootFolderId);
    const nestedFolderId = nestedFolder.json.folder.id as string;

    const listedFolders = await requestJson(fileFoldersPath, 'GET', operatorSecret);
    expect(listedFolders.res.status).toBe(200);
    expect(listedFolders.json.folders.map((folder: any) => folder.id)).toContain(rootFolderId);
    expect(listedFolders.json.folders.map((folder: any) => folder.id)).toContain(nestedFolderId);

    const filePrepare = await requestJson(
      `/api/v4/flightdeck-pg/workspaces/${workspaceId}/storage/prepare`,
      'POST',
      operatorSecret,
      {
        content_type: 'application/pdf',
        size_bytes: 7,
        file_name: 'brief.pdf',
      },
    );
    expect(filePrepare.res.status).toBe(201);
    const fileObjectId = filePrepare.json.object_id as string;
    const fileBytes = new TextEncoder().encode('brief-v');
    const fileUploadPath = `/api/v4/storage/${fileObjectId}`;
    const fileUpload = await requestJson(fileUploadPath, 'PUT', operatorSecret, { base64_data: Buffer.from(fileBytes).toString('base64') });
    expect(fileUpload.res.status).toBe(200);
    const fileComplete = await requestJson(
      `/api/v4/storage/${fileObjectId}/complete`,
      'POST',
      operatorSecret,
      { size_bytes: fileBytes.byteLength, sha256_hex: sha256Hex(fileBytes) },
    );
    expect(fileComplete.res.status).toBe(200);

    const filesPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${websiteChannelId}/files`;
    const folderFile = await requestJson(filesPath, 'POST', operatorSecret, {
      storage_object_id: fileObjectId,
      display_name: 'Brief.pdf',
      folder_id: nestedFolderId,
    });
    expect(folderFile.res.status).toBe(201);
    expect(folderFile.json.file.folder_id).toBe(nestedFolderId);
    const folderFileId = folderFile.json.file.id as string;

    const movedFile = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/files/${folderFileId}`, 'PATCH', operatorSecret, {
      row_version: folderFile.json.file.row_version,
      folder_id: rootFolderId,
    });
    expect(movedFile.res.status).toBe(200);
    expect(movedFile.json.file.folder_id).toBe(rootFolderId);

    const websiteTasksPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${websiteChannelId}/tasks`;
    const websiteTask = await requestJson(websiteTasksPath, 'POST', operatorSecret, {
      title: 'Publish new homepage copy',
      description: 'Smoke task created by Operator for Website.',
      priority: 'rock',
    });
    expect(websiteTask.res.status).toBe(201);
    expect(websiteTask.json.task.row_version).toBe(1);
    const websiteTaskId = websiteTask.json.task.id as string;

    const blogsTasksPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/channels/${blogsChannelId}/tasks`;
    const blogsTask = await requestJson(blogsTasksPath, 'POST', operatorSecret, {
      title: 'Draft hidden blog calendar',
    });
    expect(blogsTask.res.status).toBe(201);
    const blogsTaskId = blogsTask.json.task.id as string;

    const collaboratorWebsiteTasks = await requestJson(websiteTasksPath, 'GET', collaboratorSecret);
    expect(collaboratorWebsiteTasks.res.status).toBe(200);
    expect(collaboratorWebsiteTasks.json.tasks.map((task: any) => task.id)).toContain(websiteTaskId);

    const collaboratorBlogsTasks = await requestJson(blogsTasksPath, 'GET', collaboratorSecret);
    expect(collaboratorBlogsTasks.res.status).toBe(403);
    expect(collaboratorBlogsTasks.json.code).toBe('permission_denied');
    expect(collaboratorBlogsTasks.json.required_permission).toBe('task.read');

    const taskPath = `/api/v4/flightdeck-pg/workspaces/${workspaceId}/tasks/${websiteTaskId}`;
    const collaboratorUpdate = await requestJson(taskPath, 'PATCH', collaboratorSecret, {
      title: 'Publish approved homepage copy',
      row_version: websiteTask.json.task.row_version,
    });
    expect(collaboratorUpdate.res.status).toBe(200);
    expect(collaboratorUpdate.json.task.title).toBe('Publish approved homepage copy');
    expect(collaboratorUpdate.json.task.updated_by_actor_id).toBe(collaboratorId);

    const collaboratorState = await requestJson(`${taskPath}/state`, 'POST', collaboratorSecret, {
      state: 'in_progress',
      row_version: collaboratorUpdate.json.task.row_version,
    });
    expect(collaboratorState.res.status).toBe(200);
    expect(collaboratorState.json.task.state).toBe('in_progress');

    const collaboratorComment = await requestJson(`${taskPath}/comments`, 'POST', collaboratorSecret, {
      body: 'Collaborator verified Website access during backend smoke.',
    });
    expect(collaboratorComment.res.status).toBe(201);
    expect(collaboratorComment.json.comment.task_id).toBe(websiteTaskId);
    expect(collaboratorComment.json.comment.created_by_actor_id).toBe(collaboratorId);

    const collaboratorScopeRollup = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/scopes/${scopeId}/tasks`, 'GET', collaboratorSecret);
    expect(collaboratorScopeRollup.res.status).toBe(200);
    const rollupIds = collaboratorScopeRollup.json.tasks.map((task: any) => task.id);
    expect(rollupIds).toContain(websiteTaskId);
    expect(rollupIds).not.toContain(blogsTaskId);

    const collaboratorEvents = await requestJson(`/api/v4/flightdeck-pg/workspaces/${workspaceId}/events?limit=50`, 'GET', collaboratorSecret);
    expect(collaboratorEvents.res.status).toBe(200);
    expect(collaboratorEvents.json.next_cursor).toBeTruthy();
    const eventEntityIds = collaboratorEvents.json.events.map((event: any) => event.entity_id);
    expect(eventEntityIds).toContain(websiteTaskId);
    expect(eventEntityIds).not.toContain(blogsTaskId);
  });
});
