import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import {
  authorizeFlightDeckPgOperation,
  createFlightDeckPgNestedGroupEdge,
  getEffectiveFlightDeckPgGroupIds,
  isFlightDeckPgSetupActorDisplayName,
  resolveOrCreateFlightDeckPgActor,
} from '../src/services/flightdeck-pg-authorization';
import {
  authorizeFlightDeckPgStorageAttach,
  createFlightDeckPgStorageLink,
  resolveReadableFlightDeckPgStorageObject,
} from '../src/services/flightdeck-pg-storage-access';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_authorization';

let sql: ReturnType<typeof postgres>;

function testNpub(label: string): string {
  return nip19.npubEncode(createHash('sha256').update(label, 'utf8').digest('hex'));
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

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);

  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }
});

afterAll(async () => {
  await closeDb();
});

describe('Flight Deck PG actor identity resolution', () => {
  test('workspace setup placeholders cannot rename or reclassify an existing agent', async () => {
    const npub = testNpub('fdpg-auth-existing-agent-setup-placeholder');
    const original = await resolveOrCreateFlightDeckPgActor(npub, 'agent', {
      displayName: 'Workspace Member',
      sql,
    });

    expect(isFlightDeckPgSetupActorDisplayName('Workspace Creator')).toBe(true);

    const resolved = await resolveOrCreateFlightDeckPgActor(npub, 'human', {
      displayName: 'Workspace Creator',
      sql,
    });

    expect(resolved.id).toBe(original.id);
    expect(resolved.npub).toBe(npub);
    expect(resolved.kind).toBe('agent');
    expect(resolved.display_name).toBe('Workspace Member');
  });
});

type AuthorizationFixture = {
  workspaceId: string;
  appNpub: string;
  actors: {
    direct: { id: string; npub: string };
    group: { id: string; npub: string };
    nested: { id: string; npub: string };
    workspaceOnly: { id: string; npub: string };
  };
  groups: {
    parent: string;
    child: string;
  };
  scopes: {
    primary: string;
    sibling: string;
  };
  channels: {
    primary: string;
    sibling: string;
  };
};

async function expectSqlFailure(action: () => Promise<unknown>, code?: string) {
  try {
    await action();
  } catch (error) {
    if (code) {
      expect((error as { code?: string }).code).toBe(code);
    }
    return;
  }
  throw new Error('Expected SQL statement to fail');
}

async function seedAuthorizationFixture(label: string): Promise<AuthorizationFixture> {
  const appNpub = testNpub(`fdpg-auth-app-${label}`);
  const direct = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-direct-${label}`), 'human', { sql });
  const group = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-group-${label}`), 'human', { sql });
  const nested = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-nested-${label}`), 'agent', { sql });
  const workspaceOnly = await resolveOrCreateFlightDeckPgActor(testNpub(`fdpg-auth-workspace-only-${label}`), 'human', { sql });

  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub,
      workspace_service_npub,
      workspace_owner_npub,
      app_npub,
      name,
      created_by_actor_id
    )
    VALUES (
      ${testNpub(`fdpg-auth-tower-${label}`)},
      ${testNpub(`fdpg-auth-workspace-${label}`)},
      ${testNpub(`fdpg-auth-owner-${label}`)},
      ${appNpub},
      ${`Auth ${label}`},
      ${direct.id}
    )
    RETURNING id
  `;

  for (const actor of [direct, group, nested, workspaceOnly]) {
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${actor.id}, 'member', ${direct.id})
    `;
  }

  const [parent] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`Managers ${label}`}, 'system', ${direct.id})
    RETURNING id
  `;
  const [child] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`AIAgents ${label}`}, 'system', ${direct.id})
    RETURNING id
  `;

  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES
      (${workspace.id}, ${parent.id}, ${group.id}, ${direct.id}),
      (${workspace.id}, ${child.id}, ${nested.id}, ${direct.id})
  `;

  const edge = await createFlightDeckPgNestedGroupEdge(
    {
      workspaceId: workspace.id,
      parentGroupId: parent.id,
      childGroupId: child.id,
      createdByActorId: direct.id,
    },
    sql,
  );
  expect(edge.ok).toBe(true);

  const [scope] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`Scope ${label}`}, 'project', ${direct.id})
    RETURNING id
  `;
  const [siblingScope] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${`Sibling Scope ${label}`}, 'project', ${direct.id})
    RETURNING id
  `;
  const [primaryChannel] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${scope.id}, ${`Primary ${label}`}, 'channel', ${direct.id})
    RETURNING id
  `;
  const [siblingChannel] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
    VALUES (${workspace.id}, ${scope.id}, ${`Sibling ${label}`}, 'channel', ${direct.id})
    RETURNING id
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
    VALUES (
      ${workspace.id},
      'actor',
      ${direct.id},
      'channel',
      ${primaryChannel.id},
      'channel.read',
      ${direct.id}
    )
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      resource_channel_id,
      permission,
      created_by_actor_id
    )
    VALUES
      (${workspace.id}, 'group', ${parent.id}, 'channel', ${primaryChannel.id}, 'channel.read', ${direct.id}),
      (${workspace.id}, 'group', ${parent.id}, 'channel', ${primaryChannel.id}, 'task.read', ${direct.id})
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
    VALUES (${workspace.id}, 'actor', ${workspaceOnly.id}, 'workspace', 'workspace.read', ${direct.id})
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
    VALUES (${workspace.id}, 'actor', ${direct.id}, 'workspace', 'scope.create', ${direct.id})
  `;

  await sql`
    INSERT INTO flightdeck_pg_permission_grants (
      workspace_id,
      principal_type,
      principal_group_id,
      resource_type,
      resource_scope_id,
      permission,
      created_by_actor_id
    )
    VALUES (${workspace.id}, 'group', ${parent.id}, 'scope', ${scope.id}, 'channel.create', ${direct.id})
  `;

  return {
    workspaceId: workspace.id,
    appNpub,
    actors: {
      direct,
      group,
      nested,
      workspaceOnly,
    },
    groups: {
      parent: parent.id,
      child: child.id,
    },
    scopes: {
      primary: scope.id,
      sibling: siblingScope.id,
    },
    channels: {
      primary: primaryChannel.id,
      sibling: siblingChannel.id,
    },
  };
}

describe('Flight Deck PG authorization service', () => {
  test('computes direct group membership', async () => {
    const fixture = await seedAuthorizationFixture('directgroups');
    const groups = await getEffectiveFlightDeckPgGroupIds(fixture.workspaceId, fixture.actors.group.id, sql);
    expect(groups).toContain(fixture.groups.parent);
    expect(groups).not.toContain(fixture.groups.child);
  });

  test('computes nested group membership through parent group edges', async () => {
    const fixture = await seedAuthorizationFixture('nestedgroups');
    const groups = await getEffectiveFlightDeckPgGroupIds(fixture.workspaceId, fixture.actors.nested.id, sql);
    expect(groups).toContain(fixture.groups.child);
    expect(groups).toContain(fixture.groups.parent);
  });

  test('rejects nested group cycles before mutation', async () => {
    const fixture = await seedAuthorizationFixture('cyclecheck');
    const selfEdge = await createFlightDeckPgNestedGroupEdge(
      {
        workspaceId: fixture.workspaceId,
        parentGroupId: fixture.groups.parent,
        childGroupId: fixture.groups.parent,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );
    expect(selfEdge.ok).toBe(false);
    if (!selfEdge.ok) {
      expect(selfEdge.decision.category).toBe('validation-error');
      expect(selfEdge.decision.reason).toBe('group-edge-self-reference');
    }

    const cycleEdge = await createFlightDeckPgNestedGroupEdge(
      {
        workspaceId: fixture.workspaceId,
        parentGroupId: fixture.groups.child,
        childGroupId: fixture.groups.parent,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );
    expect(cycleEdge.ok).toBe(false);
    if (!cycleEdge.ok) {
      expect(cycleEdge.decision.category).toBe('validation-error');
      expect(cycleEdge.decision.reason).toBe('group-edge-cycle');
    }
  });

  test('denies a workspace member without channel access', async () => {
    const fixture = await seedAuthorizationFixture('workspaceonly');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.workspaceOnly.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows scope create before the target scope row exists with a workspace grant', async () => {
    const fixture = await seedAuthorizationFixture('scopecreate');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'scope.create',
        resource: { type: 'workspace' },
      },
      sql,
    );
    expect(decision.allowed).toBe(true);
  });

  test('denies scope create without a workspace create grant', async () => {
    const fixture = await seedAuthorizationFixture('scopecreatedeny');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.workspaceOnly.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'scope.create',
        resource: { type: 'workspace' },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows channel create before the target channel row exists with a parent scope grant', async () => {
    const fixture = await seedAuthorizationFixture('channelcreate');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.create',
        resource: { type: 'scope', scopeId: fixture.scopes.primary },
      },
      sql,
    );
    expect(decision.allowed).toBe(true);
  });

  test('denies channel create when the grant is on a sibling scope', async () => {
    const fixture = await seedAuthorizationFixture('channelcreatedeny');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.create',
        resource: { type: 'scope', scopeId: fixture.scopes.sibling },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows channel grants through a direct actor grant', async () => {
    const fixture = await seedAuthorizationFixture('directgrant');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.actorId).toBe(fixture.actors.direct.id);
      expect(decision.grantId).toBeTruthy();
    }
  });

  test('allows channel grants through direct and nested group grants', async () => {
    const fixture = await seedAuthorizationFixture('groupgrant');
    const groupDecision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(groupDecision.allowed).toBe(true);

    const nestedDecision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.nested.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'task.read',
        resource: { type: 'channel', channelId: fixture.channels.primary },
      },
      sql,
    );
    expect(nestedDecision.allowed).toBe(true);
    if (nestedDecision.allowed) {
      expect(nestedDecision.effectiveGroupIds).toContain(fixture.groups.parent);
      expect(nestedDecision.effectiveGroupIds).toContain(fixture.groups.child);
    }
  });

  test('denies sibling channel access without a matching channel grant', async () => {
    const fixture = await seedAuthorizationFixture('siblingdeny');
    const decision = await authorizeFlightDeckPgOperation(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        permission: 'channel.read',
        resource: { type: 'channel', channelId: fixture.channels.sibling },
      },
      sql,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('permission-denied');
    expect(decision.reason).toBe('permission-grant-required');
  });

  test('allows a channel reader to resolve a linked PG storage object', async () => {
    const fixture = await seedAuthorizationFixture('storageread');
    const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${fixture.workspaceId}
      LIMIT 1
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path,
        completed_at
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        ${fixture.actors.direct.npub},
        'brief.pdf',
        'application/pdf',
        'v4/flightdeck-pg/storage-read/brief.pdf',
        NOW()
      )
      RETURNING id
    `;

    const link = await createFlightDeckPgStorageLink(
      {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channels.primary,
        entityType: 'file',
        storageObjectId: storageObject.id,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );

    const readable = await resolveReadableFlightDeckPgStorageObject(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        storageObjectId: storageObject.id,
      },
      sql,
    );

    expect(link.channel_id).toBe(fixture.channels.primary);
    expect(readable.ok).toBe(true);
    if (readable.ok) {
      expect(readable.access.permission).toBe('channel.read');
      expect(readable.storageObject.id).toBe(storageObject.id);
    }
  });

  test('denies linked PG storage access from a sibling channel', async () => {
    const fixture = await seedAuthorizationFixture('storagesibling');
    const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${fixture.workspaceId}
      LIMIT 1
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path,
        completed_at
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        ${fixture.actors.direct.npub},
        'sibling.pdf',
        'application/pdf',
        'v4/flightdeck-pg/storage-sibling/sibling.pdf',
        NOW()
      )
      RETURNING id
    `;

    await createFlightDeckPgStorageLink(
      {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channels.sibling,
        entityType: 'file',
        storageObjectId: storageObject.id,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );

    const readable = await resolveReadableFlightDeckPgStorageObject(
      {
        actorNpub: fixture.actors.group.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        storageObjectId: storageObject.id,
      },
      sql,
    );

    expect(readable.ok).toBe(false);
    if (!readable.ok) {
      expect(readable.reason).toBe('permission-denied');
      expect(readable.access?.decision.reason).toBe('permission-grant-required');
    }
  });

  test('rejects duplicate active PG storage links before read authorization can drift channels', async () => {
    const fixture = await seedAuthorizationFixture('storagedupe');
    const [workspace] = await sql<{ workspace_owner_npub: string }[]>`
      SELECT workspace_owner_npub
      FROM flightdeck_pg_workspaces
      WHERE id = ${fixture.workspaceId}
      LIMIT 1
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path,
        completed_at
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        ${fixture.actors.direct.npub},
        'dedupe.pdf',
        'application/pdf',
        'v4/flightdeck-pg/storage-dedupe/dedupe.pdf',
        NOW()
      )
      RETURNING id
    `;

    const link = await createFlightDeckPgStorageLink(
      {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channels.primary,
        entityType: 'file',
        storageObjectId: storageObject.id,
        createdByActorId: fixture.actors.direct.id,
      },
      sql,
    );

    await expectSqlFailure(
      () =>
        createFlightDeckPgStorageLink(
          {
            workspaceId: fixture.workspaceId,
            channelId: fixture.channels.sibling,
            entityType: 'file',
            storageObjectId: storageObject.id,
            createdByActorId: fixture.actors.direct.id,
          },
          sql,
        ),
      '23505',
    );

    const readable = await resolveReadableFlightDeckPgStorageObject(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        storageObjectId: storageObject.id,
      },
      sql,
    );

    expect(readable.ok).toBe(true);
    if (readable.ok) {
      expect(readable.link.id).toBe(link.id);
      expect(readable.link.channel_id).toBe(fixture.channels.primary);
      expect(readable.storageObject.id).toBe(storageObject.id);
    }
  });

  test('requires channel write or entity write before attaching PG storage', async () => {
    const fixture = await seedAuthorizationFixture('storageattach');

    const denied = await authorizeFlightDeckPgStorageAttach(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        entityType: 'file',
        channelId: fixture.channels.primary,
      },
      sql,
    );
    expect(denied.allowed).toBe(false);

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
      VALUES (
        ${fixture.workspaceId},
        'actor',
        ${fixture.actors.direct.id},
        'channel',
        ${fixture.channels.primary},
        'channel.write',
        ${fixture.actors.direct.id}
      )
    `;

    const channelWriter = await authorizeFlightDeckPgStorageAttach(
      {
        actorNpub: fixture.actors.direct.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        entityType: 'file',
        channelId: fixture.channels.primary,
      },
      sql,
    );
    expect(channelWriter.allowed).toBe(true);
    if (channelWriter.allowed) expect(channelWriter.permission).toBe('channel.write');

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
      VALUES (
        ${fixture.workspaceId},
        'actor',
        ${fixture.actors.workspaceOnly.id},
        'channel',
        ${fixture.channels.primary},
        'file.write',
        ${fixture.actors.direct.id}
      )
    `;

    const entityWriter = await authorizeFlightDeckPgStorageAttach(
      {
        actorNpub: fixture.actors.workspaceOnly.npub,
        appNpub: fixture.appNpub,
        workspaceId: fixture.workspaceId,
        entityType: 'file',
        channelId: fixture.channels.primary,
      },
      sql,
    );
    expect(entityWriter.allowed).toBe(true);
    if (entityWriter.allowed) expect(entityWriter.permission).toBe('file.write');
  });
});
