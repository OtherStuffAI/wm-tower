import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { closeDb, setDb } from '../src/db';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { completeInstallIntent } from '../src/services/wapp-management';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_flightdeck_pg_schema';

let sql: ReturnType<typeof postgres>;

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

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);

  for (const stmt of statements) {
    await sql.unsafe(stmt);
  }

  await sql.unsafe(`
    ALTER TABLE flightdeck_pg_storage_links
    ADD CONSTRAINT flightdeck_pg_storage_links_workspace_id_entity_type_entity_id_storage_object_id_key
    UNIQUE (workspace_id, entity_type, entity_id, storage_object_id)
  `);

  setDb(sql);
  await ensureRuntimeSchema(sql);
});

afterAll(async () => {
  await closeDb();
});

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

describe('Flight Deck PG schema foundation', () => {
  test('adds nullable turn identity for legacy agent activity rows', async () => {
    const [column] = await sql<{ is_nullable: string; data_type: string }[]>`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_agent_activities'
        AND column_name = 'turn_id'
    `;
    expect(column).toEqual({ is_nullable: 'YES', data_type: 'text' });
  });

  test('keeps archived_at available on every searchable archive-aware record table', async () => {
    const columns = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'archived_at'
        AND table_name IN ('flightdeck_pg_docs', 'flightdeck_pg_files', 'flightdeck_pg_threads')
      ORDER BY table_name
    `;

    expect(columns.map((row) => row.table_name)).toEqual([
      'flightdeck_pg_docs',
      'flightdeck_pg_files',
      'flightdeck_pg_threads',
    ]);
  });

  test('creates the additive PH1-3 tables with key identity columns', async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE 'flightdeck_pg_%'
      ORDER BY table_name
    `;

    expect(tables.map((row) => row.table_name)).toEqual([
      'flightdeck_pg_actor_identity_history',
      'flightdeck_pg_actor_identity_rotations',
      'flightdeck_pg_actors',
      'flightdeck_pg_agent_activities',
      'flightdeck_pg_agent_activity_commentary',
      'flightdeck_pg_approvals',
      'flightdeck_pg_audio_notes',
      'flightdeck_pg_audit_events',
      'flightdeck_pg_channels',
      'flightdeck_pg_daily_note_versions',
      'flightdeck_pg_daily_notes',
      'flightdeck_pg_daily_scope_agent_access',
      'flightdeck_pg_doc_comments',
      'flightdeck_pg_doc_recovery_versions',
      'flightdeck_pg_doc_versions',
      'flightdeck_pg_docs',
      'flightdeck_pg_edit_leases',
      'flightdeck_pg_event_subscription_agents',
      'flightdeck_pg_file_folders',
      'flightdeck_pg_file_versions',
      'flightdeck_pg_files',
      'flightdeck_pg_group_edges',
      'flightdeck_pg_group_memberships',
      'flightdeck_pg_groups',
      'flightdeck_pg_invocations',
      'flightdeck_pg_messages',
      'flightdeck_pg_notification_deliveries',
      'flightdeck_pg_notification_preferences',
      'flightdeck_pg_outbox_events',
      'flightdeck_pg_permission_definitions',
      'flightdeck_pg_permission_grants',
      'flightdeck_pg_personal_agent_settings',
      'flightdeck_pg_personal_wapps',
      'flightdeck_pg_push_subscriptions',
      'flightdeck_pg_reactions',
      'flightdeck_pg_resource_view_state_rollouts',
      'flightdeck_pg_resource_view_states',
      'flightdeck_pg_response_activities',
      'flightdeck_pg_scopes',
      'flightdeck_pg_storage_links',
      'flightdeck_pg_task_assignments',
      'flightdeck_pg_task_comments',
      'flightdeck_pg_task_watchers',
      'flightdeck_pg_tasks',
      'flightdeck_pg_threads',
      'flightdeck_pg_wapp_activity_items',
      'flightdeck_pg_wapp_activity_mutes',
      'flightdeck_pg_wapp_activity_user_state',
      'flightdeck_pg_wapp_activity_versions',
      'flightdeck_pg_wapp_delegations',
      'flightdeck_pg_wapp_install_intents',
      'flightdeck_pg_wapp_installations',
      'flightdeck_pg_wapp_publication_buckets',
      'flightdeck_pg_wapp_publishing_audit',
      'flightdeck_pg_wapp_publishing_destinations',
      'flightdeck_pg_wapp_publishing_grants',
      'flightdeck_pg_workroom_events',
      'flightdeck_pg_workroom_links',
      'flightdeck_pg_workroom_participants',
      'flightdeck_pg_workrooms',
      'flightdeck_pg_workspace_memberships',
      'flightdeck_pg_workspaces',
    ]);

    const activityColumns = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'activity_version'
        AND table_name IN ('flightdeck_pg_threads', 'flightdeck_pg_tasks', 'flightdeck_pg_docs')
      ORDER BY table_name
    `;
    expect(activityColumns.map((row) => row.table_name)).toEqual([
      'flightdeck_pg_docs',
      'flightdeck_pg_tasks',
      'flightdeck_pg_threads',
    ]);

    const identityColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_workspaces'
        AND column_name IN ('id', 'tower_service_npub', 'workspace_service_npub', 'workspace_owner_npub', 'app_npub', 'v4_workspace_id')
      ORDER BY column_name
    `;

    expect(identityColumns.map((row) => row.column_name)).toEqual([
      'app_npub',
      'id',
      'tower_service_npub',
      'v4_workspace_id',
      'workspace_owner_npub',
      'workspace_service_npub',
    ]);
  });

  test('creates replay-safe agent activity commentary with owning-activity cascade retention', async () => {
    // Simulate an existing Tower schema from before commentary history existed.
    await sql`DROP TABLE flightdeck_pg_agent_activity_commentary`;
    await ensureRuntimeSchema(sql);
    await ensureRuntimeSchema(sql);

    const constraints = await sql<{ constraint_name: string }[]>`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_agent_activity_commentary'
      ORDER BY constraint_name
    `;
    expect(constraints.map((row) => row.constraint_name)).toContain(
      'fd_pg_agent_commentary_turn_sequence_key',
    );

    const [foreignKey] = await sql<{ delete_rule: string }[]>`
      SELECT delete_rule
      FROM information_schema.referential_constraints
      WHERE constraint_schema = 'public'
        AND constraint_name = 'flightdeck_pg_agent_activity_commentary_agent_activity_id_fkey'
    `;
    expect(foreignKey?.delete_rule).toBe('CASCADE');

  });

  test('bootstraps and runtime-recovers the WApp activity publishing v1 schema', async () => {
    const tableNames = [
      'flightdeck_pg_wapp_activity_items',
      'flightdeck_pg_wapp_activity_mutes',
      'flightdeck_pg_wapp_activity_user_state',
      'flightdeck_pg_wapp_activity_versions',
      'flightdeck_pg_wapp_installations',
      'flightdeck_pg_wapp_publication_buckets',
      'flightdeck_pg_wapp_publishing_audit',
      'flightdeck_pg_wapp_publishing_destinations',
      'flightdeck_pg_wapp_publishing_grants',
    ];
    const before = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ${sql(tableNames)}
      ORDER BY table_name
    `;
    expect(before.map((row) => row.table_name)).toEqual([...tableNames].sort());

    await sql.unsafe('DROP TABLE flightdeck_pg_wapp_installations CASCADE');
    await ensureRuntimeSchema(sql);

    const after = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ${sql(tableNames)}
      ORDER BY table_name
    `;
    expect(after.map((row) => row.table_name)).toEqual([...tableNames].sort());
  });

  test('registers the current publisher namespace when a managed install completes', async () => {
    const ownerNpub = 'npub1managedcompletionowner';
    const publisherNpub = 'npub1managedcompletionpublisher';
    const legacyPublisherNpub = 'npub1managedcompletionlegacy';
    const autopilotNpub = 'npub1managedcompletionautopilot';
    const [owner] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES (${ownerNpub}, 'human', 'Managed completion owner')
      RETURNING id
    `;
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
        'npub1managedcompletiontower',
        'npub1managedcompletionworkspace',
        ${ownerNpub},
        'npub1managedcompletionflightdeck',
        'Managed completion workspace',
        ${owner.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${owner.id}, 'owner', ${owner.id})
    `;
    await sql`
      INSERT INTO workspace_apps (
        workspace_owner_npub,
        app_npub,
        app_name,
        enabled,
        capabilities,
        created_by_npub
      )
      VALUES (${ownerNpub}, ${legacyPublisherNpub}, 'Legacy managed app', true, '[]'::jsonb, ${ownerNpub})
    `;
    const request = {
      client_request_id: 'managed-completion-request',
      app_id: 'managed-completion-app',
      app_version: '12',
      wapp_installation_id: 'managed-completion-installation',
      title: 'Managed completion app',
      description: null,
      icon_url: null,
      launch_url: 'https://managed-completion.example.invalid',
      scope_id: null,
      channel_id: null,
      autopilot_origin: 'https://autopilot.example.invalid',
      autopilot_npub: autopilotNpub,
      registered_open_origins: ['https://managed-completion.example.invalid'],
      capabilities: [],
      destinations: [],
    };
    const [intent] = await sql<{ id: string; intent_version: number }[]>`
      INSERT INTO flightdeck_pg_wapp_install_intents (
        workspace_id,
        owner_actor_id,
        actor_id,
        signer_npub,
        client_request_id,
        request_hash,
        request,
        status,
        intent_version,
        claim_nonce_hash,
        claim_expires_at,
        claimed_by_npub,
        claimed_at
      )
      VALUES (
        ${workspace.id},
        ${owner.id},
        ${owner.id},
        ${ownerNpub},
        'managed-completion-request',
        'managed-completion-hash',
        ${sql.json(request)},
        'claimed',
        7,
        'managed-completion-challenge',
        NOW() + INTERVAL '10 minutes',
        ${autopilotNpub},
        NOW()
      )
      RETURNING id, intent_version
    `;

    await completeInstallIntent({
      workspaceId: workspace.id,
      id: intent.id,
      signerNpub: autopilotNpub,
      intentVersion: intent.intent_version,
      observed: {
        wapp_installation_id: request.wapp_installation_id,
        publisher_npub: publisherNpub,
        app_id: request.app_id,
        app_version: request.app_version,
        launch_url: request.launch_url,
        attestation_hash: 'managed-completion-attestation',
      },
    }, sql);

    const apps = await sql<{
      app_npub: string;
      app_name: string;
      enabled: boolean;
      capabilities: string[];
      created_by_npub: string;
    }[]>`
      SELECT app_npub, app_name, enabled, capabilities, created_by_npub
      FROM workspace_apps
      WHERE workspace_owner_npub = ${ownerNpub}
      ORDER BY app_npub
    `;
    expect(apps).toHaveLength(2);
    expect(apps.find((app) => app.app_npub === publisherNpub)).toEqual({
      app_npub: publisherNpub,
      app_name: request.title,
      enabled: true,
      capabilities: ['wapp', 'app-db'],
      created_by_npub: ownerNpub,
    });
    expect(apps.some((app) => app.app_npub === legacyPublisherNpub)).toBe(true);
  });

  test('runtime schema backfills completed managed publisher namespaces idempotently', async () => {
    const ownerNpub = 'npub1managedbackfillowner';
    const publisherNpub = 'npub1managedbackfillpublisher';
    const legacyPublisherNpub = 'npub1managedbackfilllegacy';
    const [owner] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES (${ownerNpub}, 'human', 'Managed backfill owner')
      RETURNING id
    `;
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
        'npub1managedbackfilltower',
        'npub1managedbackfillworkspace',
        ${ownerNpub},
        'npub1managedbackfillflightdeck',
        'Managed backfill workspace',
        ${owner.id}
      )
      RETURNING id
    `;
    const [installation] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_wapp_installations (
        wapp_installation_id,
        app_id,
        publisher_npub,
        owner_npub,
        display_name,
        lifecycle_status
      )
      VALUES (
        'managed-backfill-installation',
        'managed-backfill-app',
        ${publisherNpub},
        ${ownerNpub},
        'Managed backfill app',
        'active'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO flightdeck_pg_wapp_install_intents (
        workspace_id,
        owner_actor_id,
        actor_id,
        signer_npub,
        client_request_id,
        request_hash,
        request,
        status,
        claim_nonce_hash,
        claim_expires_at,
        claimed_by_npub,
        installation_id,
        completed_at
      )
      VALUES (
        ${workspace.id},
        ${owner.id},
        ${owner.id},
        ${ownerNpub},
        'managed-backfill-request',
        'managed-backfill-hash',
        '{}'::jsonb,
        'active',
        'managed-backfill-challenge',
        NOW(),
        'npub1managedbackfillautopilot',
        ${installation.id},
        NOW()
      )
    `;
    await sql`
      INSERT INTO workspace_apps (
        workspace_owner_npub,
        app_npub,
        app_name,
        enabled,
        capabilities,
        created_by_npub
      )
      VALUES (${ownerNpub}, ${legacyPublisherNpub}, 'Legacy managed app', true, '[]'::jsonb, ${ownerNpub})
    `;

    await ensureRuntimeSchema(sql);
    const first = await sql<{
      app_npub: string;
      app_name: string;
      enabled: boolean;
      capabilities: string[];
      updated_at: Date;
    }[]>`
      SELECT app_npub, app_name, enabled, capabilities, updated_at
      FROM workspace_apps
      WHERE workspace_owner_npub = ${ownerNpub}
      ORDER BY app_npub
    `;
    expect(first).toHaveLength(2);
    const current = first.find((app) => app.app_npub === publisherNpub);
    expect(current).toMatchObject({
      app_name: 'Managed backfill app',
      enabled: true,
      capabilities: ['wapp', 'app-db'],
    });
    expect(first.some((app) => app.app_npub === legacyPublisherNpub)).toBe(true);

    await ensureRuntimeSchema(sql);
    const [second] = await sql<{ updated_at: Date }[]>`
      SELECT updated_at
      FROM workspace_apps
      WHERE workspace_owner_npub = ${ownerNpub}
        AND app_npub = ${publisherNpub}
    `;
    expect(second.updated_at.getTime()).toBe(current?.updated_at.getTime());
  });

  test('bootstraps the PH1-2 fixture permission definitions', async () => {
    const permissions = await sql<{ permission: string; resource_type: string }[]>`
      SELECT permission, resource_type
      FROM flightdeck_pg_permission_definitions
      ORDER BY permission
    `;

    expect(permissions).toEqual([
      { permission: 'audio_note.read', resource_type: 'channel' },
      { permission: 'audio_note.write', resource_type: 'channel' },
      { permission: 'channel.create', resource_type: 'scope' },
      { permission: 'channel.grant', resource_type: 'channel' },
      { permission: 'channel.grants.manage', resource_type: 'channel' },
      { permission: 'channel.grants.read', resource_type: 'channel' },
      { permission: 'channel.manage', resource_type: 'channel' },
      { permission: 'channel.read', resource_type: 'channel' },
      { permission: 'channel.write', resource_type: 'channel' },
      { permission: 'comment.create', resource_type: 'channel' },
      { permission: 'daily_note.read', resource_type: 'workspace' },
      { permission: 'daily_note.write', resource_type: 'workspace' },
      { permission: 'doc.read', resource_type: 'channel' },
      { permission: 'doc.write', resource_type: 'channel' },
      { permission: 'event_subscription.manage', resource_type: 'workspace' },
      { permission: 'file.read', resource_type: 'channel' },
      { permission: 'file.write', resource_type: 'channel' },
      { permission: 'scope.create', resource_type: 'workspace' },
      { permission: 'scope.manage', resource_type: 'scope' },
      { permission: 'scope.read', resource_type: 'scope' },
      { permission: 'task.comment', resource_type: 'channel' },
      { permission: 'task.create', resource_type: 'channel' },
      { permission: 'task.read', resource_type: 'channel' },
      { permission: 'task.update', resource_type: 'channel' },
      { permission: 'workspace.invite', resource_type: 'workspace' },
      { permission: 'workspace.manage', resource_type: 'workspace' },
      { permission: 'workspace.read', resource_type: 'workspace' },
    ]);
  });

  test('stores native workrooms, participants, events, links, and production merge approvals', async () => {
    const [creator] = await sql<{ id: string; npub: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1workroomschemacreator', 'human', 'Workroom Creator')
      RETURNING id, npub
    `;
    const [integrator] = await sql<{ id: string; npub: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1workroomschemaintegrator', 'agent', 'Integration Autopilot')
      RETURNING id, npub
    `;
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
        'npub1workroomschematower',
        'npub1workroomschemaworkspace',
        'npub1workroomschemaowner',
        'npub1workroomschemaapp',
        'Workroom Schema Workspace',
        ${creator.id}
      )
      RETURNING id
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES
        (${workspace.id}, ${creator.id}, 'owner', ${creator.id}),
        (${workspace.id}, ${integrator.id}, 'agent', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'Workroom Scope', 'project', ${creator.id})
      RETURNING id
    `;
    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Workroom Channel', 'channel', ${creator.id})
      RETURNING id
    `;

    const [workroom] = await sql<{
      id: string;
      repo: { provider: string; owner: string; name: string; url: string };
      archive_policy: { retention: string };
    }[]>`
      INSERT INTO flightdeck_pg_workrooms (
        workspace_id,
        scope_id,
        channel_id,
        title,
        goal,
        status,
        integration_autopilot_npub,
        repo,
        branches,
        app_targets,
        approval_policy,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (
        ${workspace.id},
        ${scope.id},
        ${channel.id},
        'Importer build room',
        'Build and ship the CSV importer workflow.',
        'active',
        ${integrator.npub},
        ${sql.json({ provider: 'github', owner: 'wingman', name: 'importer', url: 'https://git.example.invalid/example-org/importer' })},
        ${sql.json({ integration: 'main', production: 'deployed' })},
        ${sql.json({ preview: { app_id: 'app_preview', url_mode: 'generated' } })},
        ${sql.json({ merge_to_production_requires_human: true, human_approver_npubs: [creator.npub] })},
        ${creator.id},
        ${creator.id}
      )
      RETURNING id, repo, archive_policy
    `;

    expect(workroom.repo).toEqual({
      provider: 'github',
      owner: 'wingman',
      name: 'importer',
      url: 'https://git.example.invalid/example-org/importer',
    });
    expect(workroom.archive_policy).toEqual({ retention: 'keep' });

    const [participant] = await sql<{ role: string; access_status: string }[]>`
      INSERT INTO flightdeck_pg_workroom_participants (
        workspace_id,
        workroom_id,
        actor_npub,
        actor_id,
        kind,
        role,
        label,
        status,
        access_status
      )
      VALUES (
        ${workspace.id},
        ${workroom.id},
        ${integrator.npub},
        ${integrator.id},
        'autopilot',
        'integration',
        'automation-agent',
        'active',
        'granted'
      )
      RETURNING role, access_status
    `;
    expect(participant).toEqual({ role: 'integration', access_status: 'granted' });

    await sql`
      INSERT INTO flightdeck_pg_workroom_events (
        workspace_id,
        workroom_id,
        scope_id,
        channel_id,
        event_type,
        actor_npub,
        actor_id,
        target_type,
        target_ref,
        title,
        payload
      )
      VALUES (
        ${workspace.id},
        ${workroom.id},
        ${scope.id},
        ${channel.id},
        'pr_ready',
        ${integrator.npub},
        ${integrator.id},
        'pull_request',
        'https://git.example.invalid/example-org/importer/pull/42',
        'Importer PR ready',
        ${sql.json({
          pr_number: 42,
          head_sha: 'abc123',
          source: 'autopilot_github_integration',
        })}
      )
    `;

    const [approval] = await sql<{ id: string; target_type: string; action: string; metadata: Record<string, unknown> }[]>`
      INSERT INTO flightdeck_pg_approvals (
        workspace_id,
        scope_id,
        channel_id,
        target_type,
        target_id,
        action,
        status,
        title,
        requested_by_actor_id,
        requested_by_npub,
        reviewer_actor_id,
        reviewer_npub,
        metadata
      )
      VALUES (
        ${workspace.id},
        ${scope.id},
        ${channel.id},
        'workroom',
        ${workroom.id},
        'production_merge',
        'requested',
        'Approve production merge',
        ${integrator.id},
        ${integrator.npub},
        ${creator.id},
        ${creator.npub},
        ${sql.json({
          repo: 'github.com/wingman/importer',
          from_branch: 'main',
          to_branch: 'deployed',
          commit: 'abc123',
          preview_url: 'https://preview.example.invalid',
          requested_by: integrator.npub,
          integration_autopilot_npub: integrator.npub,
        })}
      )
      RETURNING id, target_type, action, metadata
    `;

    expect(approval.target_type).toBe('workroom');
    expect(approval.action).toBe('production_merge');
    expect(approval.metadata).toMatchObject({
      repo: 'github.com/wingman/importer',
      from_branch: 'main',
      to_branch: 'deployed',
      commit: 'abc123',
      preview_url: 'https://preview.example.invalid',
      requested_by: integrator.npub,
      integration_autopilot_npub: integrator.npub,
    });

    await sql`
      INSERT INTO flightdeck_pg_workroom_links (
        workspace_id,
        workroom_id,
        scope_id,
        channel_id,
        link_type,
        target_type,
        target_id,
        label,
        created_by_actor_id
      )
      VALUES (
        ${workspace.id},
        ${workroom.id},
        ${scope.id},
        ${channel.id},
        'approval',
        'approval',
        ${approval.id},
        'Production merge approval',
        ${integrator.id}
      )
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_workrooms (
          workspace_id,
          scope_id,
          channel_id,
          title,
          goal,
          status,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Invalid', 'Invalid status', 'paused', ${creator.id}, ${creator.id})
      `,
      '23514',
    );
  });

  test('runtime schema dedupes NULL subscription notification deliveries before enforcing replay uniqueness', async () => {
    await sql.unsafe('DROP INDEX IF EXISTS idx_fd_pg_notification_deliveries_dedupe_subscription');

    const [actor] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1notificationschemadedupeactor', 'human', 'Notification Schema Dedupe')
      RETURNING id
    `;
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
        'npub1notificationschemadedupetower',
        'npub1notificationschemadedupeworkspace',
        'npub1notificationschemadedupeowner',
        'npub1notificationschemadedupeapp',
        'Notification Schema Dedupe',
        ${actor.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${actor.id}, 'owner', ${actor.id})
    `;
    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'Notification Schema', 'project', ${actor.id})
      RETURNING id
    `;
    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Dedupe', 'channel', ${actor.id})
      RETURNING id
    `;
    const [outbox] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_outbox_events (
        workspace_id,
        scope_id,
        channel_id,
        actor_id,
        event_type,
        entity_type,
        operation,
        payload
      )
      VALUES (
        ${workspace.id},
        ${scope.id},
        ${channel.id},
        ${actor.id},
        'flightdeck_pg.task_assignment.assigned',
        'task_assignment',
        'assigned',
        '{}'::jsonb
      )
      RETURNING id
    `;

    const insertDuplicateDelivery = () => sql`
      INSERT INTO flightdeck_pg_notification_deliveries (
        workspace_id,
        outbox_event_id,
        recipient_actor_id,
        subscription_id,
        category,
        source_entity_type,
        dedupe_key,
        decision,
        title,
        body,
        payload,
        failure_reason
      )
      VALUES (
        ${workspace.id},
        ${outbox.id},
        ${actor.id},
        NULL,
        'task_assignment',
        'task_assignment',
        'schema-null-subscription-dedupe',
        'skipped',
        'Flight Deck: Notification Schema Dedupe',
        'Task Assigned',
        '{}'::jsonb,
        'no_active_subscription'
      )
    `;

    await insertDuplicateDelivery();
    await insertDuplicateDelivery();

    await ensureRuntimeSchema(sql);

    const [remaining] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_notification_deliveries
      WHERE dedupe_key = 'schema-null-subscription-dedupe'
    `;
    expect(Number(remaining.count)).toBe(1);
    await expectSqlFailure(insertDuplicateDelivery, '23505');
  });

  test('uses owner/date as the active Daily Scope identity', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'flightdeck_pg_daily_notes'
        AND indexname LIKE 'idx_flightdeck_pg_daily_notes%active'
      ORDER BY indexname
    `;

    const ownerDateIndex = indexes.find((row) => row.indexname === 'idx_flightdeck_pg_daily_notes_owner_date_active');
    expect(ownerDateIndex?.indexdef).toContain('owner_actor_id');
    expect(ownerDateIndex?.indexdef).toContain('note_date');
    expect(indexes.map((row) => row.indexname)).not.toContain('idx_flightdeck_pg_daily_notes_date_context_active');
  });

  test('archives duplicate active Daily Scopes before recreating the owner/date index', async () => {
    const [owner] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1dailyduplicatemigrationowner', 'human', 'Daily Duplicate Owner')
      RETURNING id
    `;
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
        'npub1dailyduplicatemigrationtower',
        'npub1dailyduplicatemigrationworkspace',
        'npub1dailyduplicatemigrationowner',
        'npub1dailyduplicatemigrationapp',
        'Daily Duplicate Migration',
        ${owner.id}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${owner.id}, 'owner', ${owner.id})
    `;
    const [scopeA] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'Scope A', 'project', ${owner.id})
      RETURNING id
    `;
    const [scopeB] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'Scope B', 'project', ${owner.id})
      RETURNING id
    `;
    const [channelA] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scopeA.id}, 'Channel A', 'channel', ${owner.id})
      RETURNING id
    `;
    const [channelB] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scopeB.id}, 'Channel B', 'channel', ${owner.id})
      RETURNING id
    `;

    await sql.unsafe('DROP INDEX IF EXISTS idx_flightdeck_pg_daily_notes_owner_date_active');
    const inserted = await sql<{ id: string; title: string }[]>`
      INSERT INTO flightdeck_pg_daily_notes (
        workspace_id,
        owner_actor_id,
        scope_id,
        channel_id,
        note_date,
        title,
        body,
        created_by_actor_id,
        updated_by_actor_id,
        created_at,
        updated_at
      )
      VALUES
        (${workspace.id}, ${owner.id}, ${scopeA.id}, ${channelA.id}, '2026-06-17', 'Oldest duplicate', 'legacy scope A', ${owner.id}, ${owner.id}, '2026-06-17T08:00:00Z', '2026-06-17T08:00:00Z'),
        (${workspace.id}, ${owner.id}, ${scopeB.id}, ${channelB.id}, '2026-06-17', 'Newest duplicate', 'legacy scope B', ${owner.id}, ${owner.id}, '2026-06-17T09:00:00Z', '2026-06-17T11:00:00Z'),
        (${workspace.id}, ${owner.id}, NULL, NULL, '2026-06-17', 'Middle duplicate', 'legacy no context', ${owner.id}, ${owner.id}, '2026-06-17T10:00:00Z', '2026-06-17T10:00:00Z')
      RETURNING id, title
    `;

    await ensureRuntimeSchema(sql);

    const rows = await sql<{ id: string; title: string; status: string; row_version: number; deleted_at: string | null }[]>`
      SELECT id, title, status, row_version, deleted_at::text AS deleted_at
      FROM flightdeck_pg_daily_notes
      WHERE workspace_id = ${workspace.id}
        AND owner_actor_id = ${owner.id}
        AND note_date = '2026-06-17'
      ORDER BY title
    `;
    const activeRows = rows.filter((row) => row.deleted_at === null);
    const archivedRows = rows.filter((row) => row.deleted_at !== null);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].title).toBe('Newest duplicate');
    expect(activeRows[0].id).toBe(inserted.find((row) => row.title === 'Newest duplicate')?.id);
    expect(archivedRows).toHaveLength(2);
    expect(archivedRows.every((row) => row.status === 'archived' && row.row_version === 2)).toBe(true);

    await expectSqlFailure(async () => {
      await sql`
        INSERT INTO flightdeck_pg_daily_notes (
          workspace_id,
          owner_actor_id,
          note_date,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${owner.id}, '2026-06-17', 'Blocked duplicate', ${owner.id}, ${owner.id})
      `;
    }, '23505');
  });

  test('repairs standard groups, Workspace membership, Admins membership, and existing DM participant manage grants', async () => {
    const [owner] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1permission06owner', 'human', 'Permission 06 Owner')
      RETURNING id
    `;
    const [admin] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1permission06admin', 'human', 'Permission 06 Admin')
      RETURNING id
    `;
    const [member] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1permission06member', 'human', 'Permission 06 Member')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1permission06tower', 'npub1permission06workspace', 'npub1permission06owner', 'npub1permission06app', 'Permission 06', ${owner.id})
      RETURNING id
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES
        (${workspace.id}, ${owner.id}, 'owner', ${owner.id}),
        (${workspace.id}, ${admin.id}, 'admin', ${owner.id}),
        (${workspace.id}, ${member.id}, 'member', ${owner.id})
    `;

    const [legacyGroup] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'Managers', 'system', ${owner.id})
      RETURNING id
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'DMs', 'dm', ${owner.id})
      RETURNING id
    `;
    const [dm] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Owner and Member', 'dm', ${owner.id})
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
      VALUES (${workspace.id}, 'actor', ${member.id}, 'channel', ${dm.id}, 'channel.read', ${owner.id})
    `;

    await ensureRuntimeSchema(sql);
    await ensureRuntimeSchema(sql);

    const groups = await sql<{ name: string }[]>`
      SELECT name
      FROM flightdeck_pg_groups
      WHERE workspace_id = ${workspace.id}
      ORDER BY name
    `;
    expect(groups.map((group) => group.name)).toEqual([
      'Admins',
      'Agents',
      'Managers',
      'People',
      'Workspace',
    ]);

    const [workspaceMembers] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_group_memberships gm
      JOIN flightdeck_pg_groups g
        ON g.workspace_id = gm.workspace_id
        AND g.id = gm.group_id
      WHERE gm.workspace_id = ${workspace.id}
        AND g.name = 'Workspace'
    `;
    expect(Number(workspaceMembers.count)).toBe(3);

    const adminMembers = await sql<{ actor_id: string }[]>`
      SELECT gm.actor_id
      FROM flightdeck_pg_group_memberships gm
      JOIN flightdeck_pg_groups g
        ON g.workspace_id = gm.workspace_id
        AND g.id = gm.group_id
      WHERE gm.workspace_id = ${workspace.id}
        AND g.name = 'Admins'
      ORDER BY gm.actor_id
    `;
    expect(adminMembers.map((row) => row.actor_id).sort()).toEqual([admin.id, owner.id].sort());

    const peopleAgentsMembers = await sql<{ group_name: string; actor_id: string }[]>`
      SELECT g.name AS group_name, gm.actor_id::text AS actor_id
      FROM flightdeck_pg_group_memberships gm
      JOIN flightdeck_pg_groups g
        ON g.workspace_id = gm.workspace_id
        AND g.id = gm.group_id
      WHERE gm.workspace_id = ${workspace.id}
        AND g.name IN ('Agents', 'People')
      ORDER BY g.name, gm.actor_id
    `;
    expect(peopleAgentsMembers).toEqual([]);

    const dmManageGrants = await sql<{ actor_id: string; permission: string }[]>`
      SELECT principal_actor_id AS actor_id, permission
      FROM flightdeck_pg_permission_grants
      WHERE workspace_id = ${workspace.id}
        AND resource_type = 'channel'
        AND resource_channel_id = ${dm.id}
        AND principal_type = 'actor'
        AND principal_actor_id IN (${owner.id}, ${member.id})
        AND permission IN ('channel.manage', 'channel.grants.read', 'channel.grants.manage')
        AND revoked_at IS NULL
      ORDER BY actor_id, permission
    `;
    expect(dmManageGrants).toHaveLength(6);

    const [legacyGrants] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM flightdeck_pg_groups
      WHERE id = ${legacyGroup.id}
    `;
    expect(Number(legacyGrants.count)).toBe(1);
  });

  test('drops the stale runtime PG storage link table constraint', async () => {
    const constraints = await sql<{ constraint_name: string }[]>`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_storage_links'
        AND constraint_name LIKE 'flightdeck_pg_storage_links_workspace_id_entity_type_entity_id%'
    `;

    expect(constraints).toEqual([]);
  });

  test('idempotently allows message storage links while rejecting unknown entity types', async () => {
    await ensureRuntimeSchema(sql);
    await ensureRuntimeSchema(sql);
    const [constraint] = await sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'flightdeck_pg_storage_links'::regclass
        AND conname = 'flightdeck_pg_storage_links_entity_type_check'
      LIMIT 1
    `;
    expect(constraint.definition).toContain("'message'::text");

    const [actor] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind)
      VALUES ('npub1messagelinkschematest', 'human')
      RETURNING id
    `;
    const [workspace] = await sql<{ id: string; workspace_owner_npub: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, created_by_actor_id
      ) VALUES ('npub1messagelinktower', 'npub1messagelinkservice', 'npub1messagelinkowner', 'npub1messagelinkapp', 'Message Link Schema', ${actor.id})
      RETURNING id, workspace_owner_npub
    `;
    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${actor.id}, 'owner', ${actor.id})
    `;
    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'Message Link Scope', 'project', ${actor.id})
      RETURNING id
    `;
    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Message Link Channel', 'channel', ${actor.id})
      RETURNING id
    `;
    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (owner_npub, created_by_npub, content_type, storage_path)
      VALUES (${workspace.workspace_owner_npub}, 'npub1messagelinkschematest', 'image/png', 'v4/message-link-schema.png')
      RETURNING id
    `;
    const [{ entity_id: entityId }] = await sql<{ entity_id: string }[]>`SELECT gen_random_uuid() AS entity_id`;
    const [messageLink] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_storage_links (
        workspace_id, scope_id, channel_id, entity_type, entity_id, storage_object_id, created_by_actor_id
      ) VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'message', ${entityId}, ${storageObject.id}, ${actor.id})
      RETURNING id
    `;
    expect(messageLink.id).toBeTruthy();
    await expectSqlFailure(
      () => sql`
        UPDATE flightdeck_pg_storage_links SET entity_type = 'browser_supplied_group' WHERE id = ${messageLink.id}
      `,
      '23514',
    );
  });

  test('enforces PH1-3A actor membership and permission resource matching constraints', async () => {
    const [member] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph13amember', 'agent', 'PH1-3A Member')
      RETURNING id
    `;

    const [nonMember] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph13anonmember', 'agent', 'PH1-3A Non-member')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph13a', 'npub1workspaceph13a', 'npub1ownerph13a', 'npub1appph13a', 'PH1-3A Workspace', ${member.id})
      RETURNING id
    `;

    const [group] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH1-3A Managers', 'system', ${member.id})
      RETURNING id
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${member.id}, 'agent', ${member.id})
    `;

    await sql`
      INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
      VALUES (${workspace.id}, ${group.id}, ${member.id}, ${member.id})
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
        VALUES (${workspace.id}, ${group.id}, ${nonMember.id}, ${member.id})
      `,
      '23503',
    );

    await sql`
      INSERT INTO flightdeck_pg_permission_grants (
        workspace_id,
        principal_type,
        principal_actor_id,
        resource_type,
        permission,
        created_by_actor_id
      )
      VALUES (${workspace.id}, 'actor', ${member.id}, 'workspace', 'workspace.read', ${member.id})
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_permission_grants (
          workspace_id,
          principal_type,
          principal_actor_id,
          resource_type,
          permission,
          created_by_actor_id
        )
        VALUES (${workspace.id}, 'actor', ${nonMember.id}, 'workspace', 'workspace.read', ${member.id})
      `,
      '23503',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_permission_grants (
          workspace_id,
          principal_type,
          principal_actor_id,
          resource_type,
          permission,
          created_by_actor_id
        )
        VALUES (${workspace.id}, 'actor', ${member.id}, 'workspace', 'scope.read', ${member.id})
      `,
      '23503',
    );
  });

  test('enforces workspace-scoped group, scope, channel, and grant constraints', async () => {
    const [actor] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1actorph13', 'agent', 'PH1-3 Actor')
      RETURNING id
    `;

    const [workspaceA] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph13', 'npub1workspaceaph13', 'npub1owneraph13', 'npub1appph13', 'Workspace A', ${actor.id})
      RETURNING id
    `;

    const [workspaceB] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph13', 'npub1workspacebph13', 'npub1ownerbph13', 'npub1appph13', 'Workspace B', ${actor.id})
      RETURNING id
    `;

    const [managers] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspaceA.id}, 'Managers', 'system', ${actor.id})
      RETURNING id
    `;

    await sql`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES
        (${workspaceA.id}, 'Viewers', 'system', ${actor.id}),
        (${workspaceA.id}, 'AIAgents', 'system', ${actor.id})
    `;

    const [workspaceBGroup] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspaceB.id}, 'Managers', 'system', ${actor.id})
      RETURNING id
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_groups (workspace_id, name, kind)
        VALUES (${workspaceA.id}, 'Managers', 'system')
      `,
      '23505',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_group_edges (workspace_id, parent_group_id, child_group_id)
        VALUES (${workspaceA.id}, ${managers.id}, ${managers.id})
      `,
      '23514',
    );

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id, owner_group_id)
      VALUES (${workspaceA.id}, 'Flight Deck', 'project', ${actor.id}, ${managers.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspaceA.id}, ${scope.id}, 'General', 'channel', ${actor.id})
      RETURNING id
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind)
        VALUES (${workspaceB.id}, ${scope.id}, 'Cross workspace', 'channel')
      `,
      '23503',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_permission_grants (
          workspace_id,
          principal_type,
          principal_group_id,
          resource_type,
          resource_channel_id,
          permission
        )
        VALUES (${workspaceA.id}, 'group', ${workspaceBGroup.id}, 'channel', ${channel.id}, 'channel.read')
      `,
      '23503',
    );

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
      VALUES (${workspaceA.id}, 'group', ${managers.id}, 'channel', ${channel.id}, 'channel.read', ${actor.id})
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_permission_grants (
          workspace_id,
          principal_type,
          principal_group_id,
          resource_type,
          resource_channel_id,
          permission
        )
        VALUES (${workspaceA.id}, 'group', ${managers.id}, 'channel', ${channel.id}, 'channel.read')
      `,
      '23505',
    );
  });

  test('enforces PH2-1 channel task board schema invariants', async () => {
    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph21creator', 'human', 'PH2-1 Creator')
      RETURNING id
    `;

    const [assignee] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph21assignee', 'agent', 'PH2-1 Assignee')
      RETURNING id
    `;

    const [nonMember] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph21nonmember', 'agent', 'PH2-1 Non-member')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph21', 'npub1workspaceph21', 'npub1ownerph21', 'npub1appph21', 'PH2-1 Workspace', ${creator.id})
      RETURNING id
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES
        (${workspace.id}, ${creator.id}, 'owner', ${creator.id}),
        (${workspace.id}, ${assignee.id}, 'agent', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH2-1 Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [otherScope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH2-1 Other Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Task Board', 'channel', ${creator.id})
      RETURNING id
    `;

    const [otherChannel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${otherScope.id}, 'Sibling Task Board', 'channel', ${creator.id})
      RETURNING id
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_tasks (
          workspace_id,
          scope_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, 'Missing channel', ${creator.id}, ${creator.id})
      `,
      '23502',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_tasks (
          workspace_id,
          scope_id,
          channel_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${otherChannel.id}, 'Wrong channel scope', ${creator.id}, ${creator.id})
      `,
      '23503',
    );

    const acceptedStates = ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'archived'];
    const tasks = await sql<{ id: string; state: string }[]>`
      INSERT INTO flightdeck_pg_tasks (
        workspace_id,
        scope_id,
        channel_id,
        title,
        state,
        created_by_actor_id,
        updated_by_actor_id
      )
      SELECT
        ${workspace.id}::uuid,
        ${scope.id}::uuid,
        ${channel.id}::uuid,
        'State ' || state,
        state,
        ${creator.id}::uuid,
        ${creator.id}::uuid
      FROM unnest(${acceptedStates}::text[]) AS state
      RETURNING id, state
    `;

    expect(tasks.map((task) => task.state).sort()).toEqual([...acceptedStates].sort());

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_tasks (
          workspace_id,
          scope_id,
          channel_id,
          title,
          state,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Bad state', 'triaged', ${creator.id}, ${creator.id})
      `,
      '23514',
    );

    const taskId = tasks.find((task) => task.state === 'ready')?.id;
    if (!taskId) throw new Error('Expected ready task to be created');

    const [comment] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_task_comments (
        workspace_id,
        scope_id,
        channel_id,
        task_id,
        body,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${taskId}, 'Valid comment', ${creator.id}, ${creator.id})
      RETURNING id
    `;

    expect(comment.id).toBeTruthy();

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_task_comments (
          workspace_id,
          scope_id,
          channel_id,
          task_id,
          body,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${otherScope.id}, ${otherChannel.id}, ${taskId}, 'Wrong task channel', ${creator.id}, ${creator.id})
      `,
      '23503',
    );

    await sql`
      INSERT INTO flightdeck_pg_task_assignments (
        workspace_id,
        scope_id,
        channel_id,
        task_id,
        actor_id,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${taskId}, ${assignee.id}, ${creator.id}, ${creator.id})
    `;

    await sql`
      INSERT INTO flightdeck_pg_task_watchers (
        workspace_id,
        scope_id,
        channel_id,
        task_id,
        actor_id,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${taskId}, ${creator.id}, ${creator.id}, ${creator.id})
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_task_assignments (
          workspace_id,
          scope_id,
          channel_id,
          task_id,
          actor_id,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${taskId}, ${nonMember.id}, ${creator.id}, ${creator.id})
      `,
      '23503',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_task_watchers (
          workspace_id,
          scope_id,
          channel_id,
          task_id,
          actor_id,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${taskId}, ${nonMember.id}, ${creator.id}, ${creator.id})
      `,
      '23503',
    );

    const outboxRows = await sql.begin(async (tx) => tx<{ id: string }[]>`
      INSERT INTO flightdeck_pg_outbox_events (
        workspace_id,
        scope_id,
        channel_id,
        actor_id,
        event_type,
        entity_type,
        entity_id,
        operation,
        entity_row_version,
        payload
      )
      VALUES (
        ${workspace.id},
        ${scope.id},
        ${channel.id},
        ${creator.id},
        'flightdeck_pg.task.created',
        'task',
        ${taskId},
        'created',
        1784873857635001,
        ${JSON.stringify({ task_id: taskId })}::jsonb
      )
      RETURNING id
    `);

    expect(outboxRows[0]?.id).toBeTruthy();

    const [outboxEntityVersionColumn] = await sql<{ data_type: string }[]>`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_outbox_events'
        AND column_name = 'entity_row_version'
    `;
    expect(outboxEntityVersionColumn?.data_type).toBe('bigint');
  });

  test('enforces PH4-1A typed channel message and thread schema invariants', async () => {
    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph41achatcreator', 'human', 'PH4-1A Chat Creator')
      RETURNING id
    `;

    const [nonMember] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph41achatnonmember', 'human', 'PH4-1A Chat Non-member')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph41a', 'npub1workspaceph41a', 'npub1ownerph41a', 'npub1appph41a', 'PH4-1A Workspace', ${creator.id})
      RETURNING id
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${creator.id}, 'owner', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH4-1A Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Chat', 'channel', ${creator.id})
      RETURNING id
    `;

    const [siblingChannel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Sibling Chat', 'channel', ${creator.id})
      RETURNING id
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_threads (
          workspace_id,
          scope_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, 'Missing channel', ${creator.id}, ${creator.id})
      `,
      '23502',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_threads (
          workspace_id,
          scope_id,
          channel_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, '', ${creator.id}, ${creator.id})
      `,
      '23514',
    );

    const [thread] = await sql<{ id: string; row_version: number }[]>`
      INSERT INTO flightdeck_pg_threads (
        workspace_id,
        scope_id,
        channel_id,
        title,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Launch thread', ${creator.id}, ${creator.id})
      RETURNING id, row_version
    `;
    expect(thread.row_version).toBe(1);

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_messages (
        workspace_id,
        scope_id,
        channel_id,
        thread_id,
        body,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${thread.id}, 'First typed message', ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(message.id).toBeTruthy();

    await sql`
      INSERT INTO flightdeck_pg_messages (
        workspace_id, scope_id, channel_id, body, client_request_id, client_request_hash,
        created_by_actor_id, updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Idempotent message', 'agentdirect:schema:1', 'hash-1', ${creator.id}, ${creator.id})
    `;
    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_messages (
          workspace_id, scope_id, channel_id, body, client_request_id, client_request_hash,
          created_by_actor_id, updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Duplicate key', 'agentdirect:schema:1', 'hash-2', ${creator.id}, ${creator.id})
      `,
      '23505',
    );

    const [updatedThread] = await sql<{ source_message_id: string; row_version: number }[]>`
      UPDATE flightdeck_pg_threads
      SET source_message_id = ${message.id}, latest = 'First typed message', row_version = row_version + 1
      WHERE id = ${thread.id}
      RETURNING source_message_id, row_version
    `;
    expect(updatedThread).toEqual({ source_message_id: message.id, row_version: 2 });

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_messages (
          workspace_id,
          scope_id,
          channel_id,
          thread_id,
          body,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${siblingChannel.id}, ${thread.id}, 'Wrong thread channel', ${creator.id}, ${creator.id})
      `,
      '23503',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_messages (
          workspace_id,
          scope_id,
          channel_id,
          body,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, '', ${creator.id}, ${creator.id})
      `,
      '23514',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_threads (
          workspace_id,
          scope_id,
          channel_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Non-member thread', ${nonMember.id}, ${creator.id})
      `,
      '23503',
    );
  });

  test('enforces one active PG storage link per storage object with non-null entity links', async () => {
    const [actor] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph40storageactor', 'human', 'PH4-0 Storage Actor')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string; workspace_owner_npub: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph40storage', 'npub1workspaceph40storage', 'npub1ownerph40storage', 'npub1appph40storage', 'PH4-0 Storage Workspace', ${actor.id})
      RETURNING id, workspace_owner_npub
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${actor.id}, 'owner', ${actor.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH4-0 Storage Scope', 'project', ${actor.id})
      RETURNING id
    `;

    const [primaryChannel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Primary Storage', 'channel', ${actor.id})
      RETURNING id
    `;

    const [siblingChannel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Sibling Storage', 'channel', ${actor.id})
      RETURNING id
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
        'npub1ph40storageactor',
        'storage-link.pdf',
        'application/pdf',
        'v4/flightdeck-pg/schema/storage-link.pdf',
        NOW()
      )
      RETURNING id
    `;

    const [{ entity_id: entityId }] = await sql<{ entity_id: string }[]>`
      SELECT gen_random_uuid() AS entity_id
    `;

    const [primaryLink] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_storage_links (
        workspace_id,
        scope_id,
        channel_id,
        entity_type,
        entity_id,
        storage_object_id,
        created_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${primaryChannel.id}, 'file', ${entityId}, ${storageObject.id}, ${actor.id})
      RETURNING id
    `;

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_storage_links (
          workspace_id,
          scope_id,
          channel_id,
          entity_type,
          entity_id,
          storage_object_id,
          created_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${siblingChannel.id}, 'file', ${entityId}, ${storageObject.id}, ${actor.id})
      `,
      '23505',
    );

    await sql`
      UPDATE flightdeck_pg_storage_links
      SET deleted_at = NOW()
      WHERE id = ${primaryLink.id}
    `;

    const [replacementLink] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_storage_links (
        workspace_id,
        scope_id,
        channel_id,
        entity_type,
        entity_id,
        storage_object_id,
        created_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${siblingChannel.id}, 'file', ${entityId}, ${storageObject.id}, ${actor.id})
      RETURNING id
    `;

    expect(replacementLink.id).toBeTruthy();
  });

  test('stores Flight Deck PG docs as metadata rows linked to storage objects', async () => {
    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph42doccreator', 'human', 'PH4-2 Doc Creator')
      RETURNING id
    `;
    const [nonMember] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph42docnonmember', 'human', 'PH4-2 Doc Non-member')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string; workspace_owner_npub: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph42docs', 'npub1workspaceph42docs', 'npub1ownerph42docs', 'npub1appph42docs', 'PH4-2 Docs Workspace', ${creator.id})
      RETURNING id, workspace_owner_npub
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${creator.id}, 'owner', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH4-2 Docs Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Docs Channel', 'channel', ${creator.id})
      RETURNING id
    `;

    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph42doccreator',
        'metadata-only.md',
        'text/markdown',
        'v4/flightdeck-pg/schema/metadata-only.md'
      )
      RETURNING id
    `;

    const [doc] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_docs (
        workspace_id,
        scope_id,
        channel_id,
        storage_object_id,
        title,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${storageObject.id}, 'Metadata only', ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(doc.id).toBeTruthy();

    const docColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_docs'
      ORDER BY column_name
    `;
    expect(docColumns.map((row) => row.column_name)).not.toContain('body');

    const [emptyTitleStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph42doccreator',
        'empty-title.md',
        'text/markdown',
        'v4/flightdeck-pg/schema/empty-title.md'
      )
      RETURNING id
    `;
    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_docs (
          workspace_id,
          scope_id,
          channel_id,
          storage_object_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${emptyTitleStorageObject.id}, '', ${creator.id}, ${creator.id})
      `,
      '23514',
    );

    const [nonMemberStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph42doccreator',
        'non-member.md',
        'text/markdown',
        'v4/flightdeck-pg/schema/non-member.md'
      )
      RETURNING id
    `;
    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_docs (
          workspace_id,
          scope_id,
          channel_id,
          storage_object_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${nonMemberStorageObject.id}, 'Non-member doc', ${nonMember.id}, ${creator.id})
      `,
      '23503',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_docs (
          workspace_id,
          scope_id,
          channel_id,
          storage_object_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${storageObject.id}, 'Duplicate storage body', ${creator.id}, ${creator.id})
      `,
      '23505',
    );
  });

  test('stores Flight Deck PG files as metadata rows linked to storage objects', async () => {
    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph43filecreator', 'human', 'PH4-3 File Creator')
      RETURNING id
    `;
    const [nonMember] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph43filenonmember', 'human', 'PH4-3 File Non-member')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string; workspace_owner_npub: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph43files', 'npub1workspaceph43files', 'npub1ownerph43files', 'npub1appph43files', 'PH4-3 Files Workspace', ${creator.id})
      RETURNING id, workspace_owner_npub
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${creator.id}, 'owner', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH4-3 Files Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Files Channel', 'channel', ${creator.id})
      RETURNING id
    `;

    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph43filecreator',
        'metadata-only.bin',
        'application/octet-stream',
        'v4/flightdeck-pg/schema/metadata-only.bin'
      )
      RETURNING id
    `;

    const [file] = await sql<{ id: string }[]>`
      WITH folder AS (
        INSERT INTO flightdeck_pg_file_folders (
          workspace_id,
          scope_id,
          channel_id,
          title,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Client assets', ${creator.id}, ${creator.id})
        RETURNING id
      )
      INSERT INTO flightdeck_pg_files (
        workspace_id,
        scope_id,
        channel_id,
        folder_id,
        storage_object_id,
        display_name,
        created_by_actor_id,
        updated_by_actor_id
      )
      SELECT ${workspace.id}, ${scope.id}, ${channel.id}, folder.id, ${storageObject.id}, 'Metadata only file', ${creator.id}, ${creator.id}
      FROM folder
      RETURNING id
    `;
    expect(file.id).toBeTruthy();

    const fileColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_files'
      ORDER BY column_name
    `;
    expect(fileColumns.map((row) => row.column_name)).toContain('folder_id');
    expect(fileColumns.map((row) => row.column_name)).toContain('current_version_id');
    expect(fileColumns.map((row) => row.column_name)).not.toContain('body');
    expect(fileColumns.map((row) => row.column_name)).not.toContain('storage_path');
    expect(fileColumns.map((row) => row.column_name)).not.toContain('thread_id');

    const fileVersionColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_file_versions'
      ORDER BY column_name
    `;
    expect(fileVersionColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'id',
      'workspace_id',
      'file_id',
      'version_number',
      'storage_object_id',
      'base_version_id',
      'operation',
      'created_by_actor_id',
      'created_at',
    ]));

    const [emptyDisplayStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph43filecreator',
        'empty-display.bin',
        'application/octet-stream',
        'v4/flightdeck-pg/schema/empty-display.bin'
      )
      RETURNING id
    `;
    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_files (
          workspace_id,
          scope_id,
          channel_id,
          storage_object_id,
          display_name,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${emptyDisplayStorageObject.id}, '', ${creator.id}, ${creator.id})
      `,
      '23514',
    );

    const [nonMemberStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph43filecreator',
        'non-member.bin',
        'application/octet-stream',
        'v4/flightdeck-pg/schema/non-member.bin'
      )
      RETURNING id
    `;
    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_files (
          workspace_id,
          scope_id,
          channel_id,
          storage_object_id,
          display_name,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${nonMemberStorageObject.id}, 'Non-member file', ${nonMember.id}, ${creator.id})
      `,
      '23503',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_files (
          workspace_id,
          scope_id,
          channel_id,
          storage_object_id,
          display_name,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${storageObject.id}, 'Duplicate file object', ${creator.id}, ${creator.id})
      `,
      '23505',
    );
  });

  test('upgrades old audio note target constraints to allow audio_note targets', async () => {
    await sql.unsafe(`
      ALTER TABLE flightdeck_pg_audio_notes
      DROP CONSTRAINT IF EXISTS flightdeck_pg_audio_notes_target_type_check
    `);
    await sql.unsafe(`
      ALTER TABLE flightdeck_pg_audio_notes
      ADD CONSTRAINT flightdeck_pg_audio_notes_target_type_check
      CHECK (target_type IS NULL OR target_type IN ('message', 'task_comment', 'task', 'doc', 'file'))
    `);
    await sql.unsafe(`
      ALTER TABLE flightdeck_pg_reactions
      DROP CONSTRAINT IF EXISTS flightdeck_pg_reactions_target_type_check
    `);
    await sql.unsafe(`
      ALTER TABLE flightdeck_pg_reactions
      ADD CONSTRAINT flightdeck_pg_reactions_target_type_check
      CHECK (target_type IN ('message', 'task_comment', 'task', 'doc', 'file'))
    `);

    await ensureRuntimeSchema(sql);

    const targetConstraints = await sql<{ table_name: string; constraint_name: string; constraint_def: string }[]>`
      SELECT
        c.relname AS table_name,
        con.conname AS constraint_name,
        pg_get_constraintdef(con.oid) AS constraint_def
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      WHERE c.relname IN ('flightdeck_pg_audio_notes', 'flightdeck_pg_reactions')
        AND con.conname IN ('flightdeck_pg_audio_notes_target_type_check', 'flightdeck_pg_reactions_target_type_check')
      ORDER BY c.relname, con.conname
    `;
    expect(targetConstraints).toHaveLength(2);
    expect(targetConstraints.every((row) => row.constraint_def.includes('audio_note'))).toBe(true);

    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph44constraintactor', 'human', 'PH4-4 Constraint Actor')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string; workspace_owner_npub: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph44constraints', 'npub1workspaceph44constraints', 'npub1ownerph44constraints', 'npub1appph44constraints', 'PH4-4 Constraint Workspace', ${creator.id})
      RETURNING id, workspace_owner_npub
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${creator.id}, 'owner', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH4-4 Constraint Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Constraint Channel', 'channel', ${creator.id})
      RETURNING id
    `;

    const [rootStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph44constraintactor',
        'root-note.webm',
        'audio/webm',
        'v4/flightdeck-pg/schema/root-note.webm'
      )
      RETURNING id
    `;

    const [targetAudioNote] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_audio_notes (
        workspace_id,
        scope_id,
        channel_id,
        storage_object_id,
        title,
        mime_type,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${rootStorageObject.id}, 'Root note', 'audio/webm', ${creator.id}, ${creator.id})
      RETURNING id
    `;

    const [replyStorageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph44constraintactor',
        'reply-note.webm',
        'audio/webm',
        'v4/flightdeck-pg/schema/reply-note.webm'
      )
      RETURNING id
    `;

    const [audioNoteReply] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_audio_notes (
        workspace_id,
        scope_id,
        channel_id,
        storage_object_id,
        target_type,
        target_id,
        title,
        mime_type,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${replyStorageObject.id}, 'audio_note', ${targetAudioNote.id}, 'Reply note', 'audio/webm', ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(audioNoteReply.id).toBeTruthy();

    const [audioNoteReaction] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_reactions (
        workspace_id,
        scope_id,
        channel_id,
        target_type,
        target_id,
        emoji,
        emoji_shortcode,
        reactor_actor_id,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'audio_note', ${targetAudioNote.id}, 'heart', ':heart:', ${creator.id}, ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(audioNoteReaction.id).toBeTruthy();
  });

  test('stores audio notes as metadata rows and constrains reaction targets', async () => {
    const [creator] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
      VALUES ('npub1ph44audioactor', 'human', 'PH4-4 Audio Actor')
      RETURNING id
    `;

    const [workspace] = await sql<{ id: string; workspace_owner_npub: string }[]>`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub,
        workspace_service_npub,
        workspace_owner_npub,
        app_npub,
        name,
        created_by_actor_id
      )
      VALUES ('npub1towerph44audio', 'npub1workspaceph44audio', 'npub1ownerph44audio', 'npub1appph44audio', 'PH4-4 Audio Workspace', ${creator.id})
      RETURNING id, workspace_owner_npub
    `;

    await sql`
      INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
      VALUES (${workspace.id}, ${creator.id}, 'owner', ${creator.id})
    `;

    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes (workspace_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, 'PH4-4 Audio Scope', 'project', ${creator.id})
      RETURNING id
    `;

    const [channel] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_channels (workspace_id, scope_id, name, kind, created_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, 'Audio Channel', 'channel', ${creator.id})
      RETURNING id
    `;

    const [storageObject] = await sql<{ id: string }[]>`
      INSERT INTO v4_storage_objects (
        owner_npub,
        created_by_npub,
        file_name,
        content_type,
        storage_path
      )
      VALUES (
        ${workspace.workspace_owner_npub},
        'npub1ph44audioactor',
        'note.webm',
        'audio/webm',
        'v4/flightdeck-pg/schema/note.webm'
      )
      RETURNING id
    `;

    const [audioNote] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_audio_notes (
        workspace_id,
        scope_id,
        channel_id,
        storage_object_id,
        title,
        mime_type,
        duration_seconds,
        size_bytes,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, ${storageObject.id}, 'Standup note', 'audio/webm', 12.5, 1024, ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(audioNote.id).toBeTruthy();

    const audioColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'flightdeck_pg_audio_notes'
      ORDER BY column_name
    `;
    expect(audioColumns.map((row) => row.column_name)).not.toContain('body');
    expect(audioColumns.map((row) => row.column_name)).not.toContain('storage_path');
    expect(audioColumns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      'thread_id',
      'media_encryption',
      'waveform_preview',
      'transcript_preview',
      'transcript',
      'record_state',
    ]));
    const [audioNoteDefaults] = await sql<{ media_encryption: Record<string, unknown>; waveform_preview: unknown[]; record_state: string }[]>`
      SELECT media_encryption, waveform_preview, record_state
      FROM flightdeck_pg_audio_notes
      WHERE id = ${audioNote.id}
    `;
    expect(audioNoteDefaults.media_encryption).toEqual({});
    expect(audioNoteDefaults.waveform_preview).toEqual([]);
    expect(audioNoteDefaults.record_state).toBe('active');

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_reactions (
          workspace_id,
          scope_id,
        channel_id,
        target_type,
        target_id,
        emoji,
        emoji_shortcode,
        reactor_actor_id,
        created_by_actor_id,
        updated_by_actor_id
      )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'encrypted_record', ${audioNote.id}, 'thumbs_up', ':thumbs_up:', ${creator.id}, ${creator.id}, ${creator.id})
      `,
      '23514',
    );

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_messages (workspace_id, scope_id, channel_id, body, created_by_actor_id, updated_by_actor_id)
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'Reactable message', ${creator.id}, ${creator.id})
      RETURNING id
    `;

    const [reaction] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_reactions (
        workspace_id,
        scope_id,
        channel_id,
        target_type,
        target_id,
        emoji,
        emoji_shortcode,
        reactor_actor_id,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'message', ${message.id}, 'thumbs_up', ':thumbs_up:', ${creator.id}, ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(reaction.id).toBeTruthy();

    const [audioReaction] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_reactions (
        workspace_id,
        scope_id,
        channel_id,
        target_type,
        target_id,
        emoji,
        emoji_shortcode,
        reactor_actor_id,
        created_by_actor_id,
        updated_by_actor_id
      )
      VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'audio_note', ${audioNote.id}, 'party', ':party:', ${creator.id}, ${creator.id}, ${creator.id})
      RETURNING id
    `;
    expect(audioReaction.id).toBeTruthy();

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_reactions (
          workspace_id,
          scope_id,
          channel_id,
          target_type,
          target_id,
          emoji,
          emoji_shortcode,
          reactor_actor_id,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'message', ${message.id}, 'thumbs_up', ':thumbs_up:', ${creator.id}, ${creator.id}, ${creator.id})
      `,
      '23505',
    );

    await expectSqlFailure(
      () => sql`
        INSERT INTO flightdeck_pg_reactions (
          workspace_id,
          scope_id,
          channel_id,
          target_type,
          target_id,
          emoji,
          emoji_shortcode,
          reactor_actor_id,
          created_by_actor_id,
          updated_by_actor_id
        )
        VALUES (${workspace.id}, ${scope.id}, ${channel.id}, 'audio_note', ${audioNote.id}, 'rocket', ':rocket:', ${creator.id}, ${creator.id}, ${creator.id})
      `,
      '23514',
    );
  });

  test('keeps encrypted record sync tables intact beside the typed schema', async () => {
    const [record] = await sql<{ id: string }[]>`
      INSERT INTO v4_records (
        record_id,
        owner_npub,
        record_family_hash,
        version,
        previous_version,
        signature_npub,
        owner_ciphertext
      )
      VALUES ('ph1-3-record', 'npub1syncownerph13', 'flightdeck-pg:compat', 1, 0, 'npub1syncownerph13', 'ciphertext')
      RETURNING id
    `;

    expect(record.id).toBeTruthy();
  });

  test('backfills retired DM participant identities to the current actor npub', async () => {
    const ownerNpub = 'npub1runtimebackfillowner';
    const retiredNpub = 'npub1runtimebackfillretired';
    const currentNpub = 'npub1runtimebackfillcurrent';
    const [owner] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${ownerNpub},'human') RETURNING id
    `;
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_actors(npub,kind) VALUES(${currentNpub},'agent') RETURNING id
    `;
    await sql`
      INSERT INTO flightdeck_pg_actor_identity_history(actor_id,npub,valid_from,valid_until,rotation_id,proof_event_id)
      VALUES(${agent.id},${retiredNpub},NOW() - INTERVAL '2 days',NOW() - INTERVAL '1 day','runtime-backfill-rotation','runtime-backfill-proof')
    `;
    const [workspace] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_workspaces(tower_service_npub,workspace_service_npub,workspace_owner_npub,app_npub,name,created_by_actor_id)
      VALUES('npub1runtimebackfilltower','npub1runtimebackfillservice',${ownerNpub},'npub1runtimebackfillapp','Runtime backfill',${owner.id})
      RETURNING id
    `;
    const [scope] = await sql<{ id: string }[]>`
      INSERT INTO flightdeck_pg_scopes(workspace_id,name,kind,created_by_actor_id)
      VALUES(${workspace.id},'Runtime backfill DMs','dm',${owner.id}) RETURNING id
    `;
    const [channel] = await sql<{ id: string; updated_at: Date }[]>`
      INSERT INTO flightdeck_pg_channels(workspace_id,scope_id,name,kind,participant_npubs,created_by_actor_id,updated_at)
      VALUES(${workspace.id},${scope.id},'Retired identity DM','dm',${[ownerNpub, retiredNpub, currentNpub, retiredNpub]},${owner.id},NOW() - INTERVAL '1 hour')
      RETURNING id,updated_at
    `;

    await ensureRuntimeSchema(sql);

    const [backfilled] = await sql<{ participant_npubs: string[]; updated_at: Date }[]>`
      SELECT participant_npubs,updated_at FROM flightdeck_pg_channels WHERE id=${channel.id}
    `;
    expect(backfilled.participant_npubs).toEqual([ownerNpub, currentNpub]);
    expect(backfilled.updated_at.getTime()).toBeGreaterThan(channel.updated_at.getTime());
  });
});
