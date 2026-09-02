import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import { clearWsKeyCacheForTests } from '../src/services/user-workspace-keys';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_app_db';

const ownerSecret = new Uint8Array(32).fill(31);
const memberSecret = new Uint8Array(32).fill(32);
const outsiderSecret = new Uint8Array(32).fill(33);
const appSecret = new Uint8Array(32).fill(34);
const otherAppSecret = new Uint8Array(32).fill(35);

const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));
const APP_NPUB = nip19.npubEncode(getPublicKey(appSecret));
const OTHER_APP_NPUB = nip19.npubEncode(getPublicKey(otherAppSecret));

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let groupId = '';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function migrationChecksum(sql: string): string {
  return `sha256:${sha256Hex(sql)}`;
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

async function runMainMigration(db: ReturnType<typeof postgres>) {
  const { readFileSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(join(__dirname, '../src/schema/001_init.sql'), 'utf-8');
  const statements = splitSqlStatements(migration);
  for (const stmt of statements) {
    await db.unsafe(stmt);
  }
}

beforeAll(async () => {
  const adminOpts: any = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOpts.password = process.env.DB_PASSWORD;

  const admin = postgres(adminOpts);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }

  const testOpts: any = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: TEST_DB,
  };
  if (process.env.DB_USER) testOpts.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) testOpts.password = process.env.DB_PASSWORD;

  sql = postgres(testOpts);
  setDb(sql);
  await runMainMigration(sql);

  const [group] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub, group_kind)
    VALUES (${OWNER}, ${'App DB Group'}, ${'npub1appdbgroup000000000000000000000000000000000000000'}, ${'workspace_shared'})
    RETURNING id
  `;
  groupId = group.id;
  await sql`
    INSERT INTO v4_group_epochs (group_id, epoch, group_npub, created_by_npub)
    VALUES (${groupId}, 1, ${'npub1appdbgroup000000000000000000000000000000000000000'}, ${OWNER})
  `;
  await sql`
    INSERT INTO v4_workspaces (
      workspace_owner_npub,
      creator_npub,
      name,
      wrapped_workspace_nsec,
      wrapped_by_npub,
      default_group_id
    ) VALUES (
      ${OWNER},
      ${OWNER},
      ${'App DB Workspace'},
      ${'wrapped-workspace-secret'},
      ${OWNER},
      ${groupId}
    )
  `;
  await sql`
    INSERT INTO v4_group_members (group_id, member_npub)
    VALUES (${groupId}, ${OWNER}), (${groupId}, ${MEMBER})
  `;
  await sql`
    INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, created_by_npub)
    VALUES
      (${OWNER}, ${APP_NPUB}, ${'Autopilot'}, ${OWNER}),
      (${OWNER}, ${OTHER_APP_NPUB}, ${'Other App'}, ${OWNER})
  `;

  app = createApp();
});

afterAll(async () => {
  clearWsKeyCacheForTests();
  if (sql) await sql.end();
});

describe('Workspace app DB API', () => {
  test('creates and reads a private row only for the owning user', async () => {
    const path = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/sessions/rows`;
    const payload = {
      row_id: 'session-1',
      data: { status: 'queued', title: 'First session' },
      metadata: { source: 'test' },
    };
    const createRes = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.row.row_id).toBe('session-1');
    expect(created.row.owner_npub).toBe(OWNER);
    expect(created.row.visibility).toBe('private');
    expect(created.row.data.status).toBe('queued');

    const ownerGetPath = `${path}/session-1`;
    const ownerGet = await app.request(ownerGetPath, {
      headers: { Authorization: authHeader(ownerGetPath, 'GET', ownerSecret) },
    });
    expect(ownerGet.status).toBe(200);

    const memberGet = await app.request(ownerGetPath, {
      headers: { Authorization: authHeader(ownerGetPath, 'GET', memberSecret) },
    });
    expect(memberGet.status).toBe(404);

    const memberList = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberSecret) },
    });
    expect(memberList.status).toBe(200);
    expect((await memberList.json()).rows).toHaveLength(0);
  });

  test('group rows are visible and writable by current group members', async () => {
    const path = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/sessions/rows`;
    const payload = {
      row_id: 'shared-session',
      visibility: 'group',
      group_id: groupId,
      data: { status: 'running' },
    };
    const createRes = await app.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createRes.status).toBe(201);

    const patchPath = `${path}/shared-session`;
    const update = { data: { status: 'done' } };
    const patchRes = await app.request(patchPath, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(patchPath, 'PATCH', memberSecret, update),
      },
      body: JSON.stringify(update),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).row.data.status).toBe('done');
  });

  test('outsiders and unregistered app namespaces are rejected', async () => {
    const path = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/sessions/rows`;
    const outsiderRes = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', outsiderSecret) },
    });
    expect(outsiderRes.status).toBe(403);

    const missingPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(OUTSIDER)}/db/sessions/rows`;
    const missingRes = await app.request(missingPath, {
      headers: { Authorization: authHeader(missingPath, 'GET', ownerSecret) },
    });
    expect(missingRes.status).toBe(404);
  });

  test('app namespaces are isolated even with matching collection and row ids', async () => {
    const appPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/tasks/rows`;
    const otherPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(OTHER_APP_NPUB)}/db/tasks/rows`;

    const payload = { row_id: 'task-1', visibility: 'workspace', data: { app: 'autopilot' } };
    const otherPayload = { row_id: 'task-1', visibility: 'workspace', data: { app: 'other' } };

    const createAppRow = await app.request(appPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(appPath, 'POST', ownerSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createAppRow.status).toBe(201);

    const createOtherRow = await app.request(otherPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(otherPath, 'POST', ownerSecret, otherPayload),
      },
      body: JSON.stringify(otherPayload),
    });
    expect(createOtherRow.status).toBe(201);

    const appList = await app.request(appPath, {
      headers: { Authorization: authHeader(appPath, 'GET', memberSecret) },
    });
    expect(appList.status).toBe(200);
    const body = await appList.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].data.app).toBe('autopilot');
  });

  test('provisions a relational WApp namespace and runs app-signed migrations idempotently', async () => {
    const provisionPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/provision`;
    const provisionBody = { app_slug: 'kindling' };
    const provisionRes = await app.request(provisionPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(provisionPath, 'POST', appSecret, provisionBody),
      },
      body: JSON.stringify(provisionBody),
    });
    expect(provisionRes.status).toBe(201);
    const descriptor = await provisionRes.json();
    expect(descriptor.schema_name).toStartWith('wapp_kindling_');
    expect(descriptor.capabilities.migrations).toBe(true);

    const memberDescriptor = await app.request(`/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/descriptor`, {
      headers: {
        Authorization: authHeader(`/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/descriptor`, 'GET', memberSecret),
      },
    });
    expect(memberDescriptor.status).toBe(403);

    const migrationSql = `
      CREATE TABLE companies (
        id text PRIMARY KEY,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        profile jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX companies_status_idx ON companies(status);
    `;
    const migrationBody = {
      migrations: [{
        version: '001_init',
        checksum: migrationChecksum(migrationSql),
        sql: migrationSql,
      }],
    };
    const migrationsPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/migrations`;
    const migrateRes = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, migrationBody),
      },
      body: JSON.stringify(migrationBody),
    });
    expect(migrateRes.status).toBe(200);
    expect((await migrateRes.json()).applied[0].version).toBe('001_init');

    const migrateAgain = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, migrationBody),
      },
      body: JSON.stringify(migrationBody),
    });
    expect(migrateAgain.status).toBe(200);

    const conflictingBody = {
      migrations: [{
        version: '001_init',
        checksum: migrationChecksum('CREATE TABLE other_table (id text PRIMARY KEY);'),
        sql: 'CREATE TABLE other_table (id text PRIMARY KEY);',
      }],
    };
    const conflictRes = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, conflictingBody),
      },
      body: JSON.stringify(conflictingBody),
    });
    expect(conflictRes.status).toBe(409);
  });

  test('rejects non-app signers, unsafe identifiers, and forbidden migration SQL for relational WApp DB', async () => {
    const rowsPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/tables/companies/rows`;
    const createBody = { id: 'company_blocked', data: { name: 'Blocked', status: 'queued' } };
    const memberCreate = await app.request(rowsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(rowsPath, 'POST', memberSecret, createBody),
      },
      body: JSON.stringify(createBody),
    });
    expect(memberCreate.status).toBe(403);

    const unsafePath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/tables/public.companies/rows`;
    const unsafeRes = await app.request(unsafePath, {
      headers: { Authorization: authHeader(unsafePath, 'GET', appSecret) },
    });
    expect(unsafeRes.status).toBe(400);

    const migrationsPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/migrations`;
    const badSql = 'CREATE FUNCTION bad() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;';
    const badMigration = {
      migrations: [{ version: '002_bad', checksum: migrationChecksum(badSql), sql: badSql }],
    };
    const badMigrationRes = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, badMigration),
      },
      body: JSON.stringify(badMigration),
    });
    expect(badMigrationRes.status).toBe(400);
  });

  test('rejects reserved migration history targets and unsafe schema-qualified migration SQL', async () => {
    const descriptorPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/descriptor`;
    const descriptorRes = await app.request(descriptorPath, {
      headers: { Authorization: authHeader(descriptorPath, 'GET', appSecret) },
    });
    expect(descriptorRes.status).toBe(200);
    const descriptor = await descriptorRes.json();
    const schemaName = descriptor.schema_name;
    const migrationsPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/migrations`;

    async function expectMigrationRejected(version: string, sqlText: string) {
      const body = {
        migrations: [{ version, checksum: migrationChecksum(sqlText), sql: sqlText }],
      };
      const res = await app.request(migrationsPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader(migrationsPath, 'POST', appSecret, body),
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }

    await expectMigrationRejected('002_reserved_create', 'CREATE TABLE schema_migrations (id text PRIMARY KEY);');
    await expectMigrationRejected('002_reserved_alter', 'ALTER TABLE schema_migrations ADD COLUMN mutated text;');
    await expectMigrationRejected('002_reserved_drop', `DROP TABLE "${schemaName}".schema_migrations;`);
    await expectMigrationRejected('002_reserved_index', 'CREATE INDEX bad_history_idx ON schema_migrations(version);');
    await expectMigrationRejected('002_public_schema', 'CREATE TABLE public.not_allowed (id text PRIMARY KEY);');
    await expectMigrationRejected('002_unsupported', 'SELECT 1;');
    await expectMigrationRejected('002_ctas_public_leak', 'CREATE TABLE app_copy AS SELECT * FROM workspace_apps;');
    await expectMigrationRejected('002_unqualified_public_reference', 'CREATE TABLE local_ref (id text REFERENCES workspace_apps(app_npub));');

    const qualifiedSql = `CREATE TABLE "${schemaName}".qualified_allowed (id text PRIMARY KEY);`;
    const qualifiedBody = {
      migrations: [{ version: '002_qualified_allowed', checksum: migrationChecksum(qualifiedSql), sql: qualifiedSql }],
    };
    const qualifiedRes = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, qualifiedBody),
      },
      body: JSON.stringify(qualifiedBody),
    });
    expect(qualifiedRes.status).toBe(200);

    const localReferenceSql = `CREATE TABLE local_ref_ok (id text PRIMARY KEY, company_id text REFERENCES "${schemaName}".companies(id));`;
    const localReferenceBody = {
      migrations: [{ version: '002_local_reference_allowed', checksum: migrationChecksum(localReferenceSql), sql: localReferenceSql }],
    };
    const localReferenceRes = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, localReferenceBody),
      },
      body: JSON.stringify(localReferenceBody),
    });
    expect(localReferenceRes.status).toBe(200);

    const stateRes = await app.request(migrationsPath, {
      headers: { Authorization: authHeader(migrationsPath, 'GET', appSecret) },
    });
    expect(stateRes.status).toBe(200);
    const state = await stateRes.json();
    expect(state.migrations.map((row: { version: string }) => row.version)).toContain('001_init');

    const conflictingBody = {
      migrations: [{
        version: '001_init',
        checksum: migrationChecksum('CREATE TABLE conflict_after_reserved (id text PRIMARY KEY);'),
        sql: 'CREATE TABLE conflict_after_reserved (id text PRIMARY KEY);',
      }],
    };
    const conflictRes = await app.request(migrationsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(migrationsPath, 'POST', appSecret, conflictingBody),
      },
      body: JSON.stringify(conflictingBody),
    });
    expect(conflictRes.status).toBe(409);
  });

  test('performs app-signed relational CRUD and constrained query without breaking JSONB rows', async () => {
    const rowsPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/tables/companies/rows`;
    const createBody = {
      id: 'company_123',
      data: { name: 'North HVAC', status: 'queued', profile: { tier: 'gold' } },
    };
    const createRes = await app.request(rowsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(rowsPath, 'POST', appSecret, createBody),
      },
      body: JSON.stringify(createBody),
    });
    expect(createRes.status).toBe(201);
    expect((await createRes.json()).row.id).toBe('company_123');

    const patchPath = `${rowsPath}/company_123`;
    const patchBody = { set: { status: 'complete' } };
    const patchRes = await app.request(patchPath, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(patchPath, 'PATCH', appSecret, patchBody),
      },
      body: JSON.stringify(patchBody),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).row.status).toBe('complete');

    const queryPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/tables/companies/query`;
    const queryBody = {
      select: ['id', 'name', 'status'],
      where: { status: { eq: 'complete' } },
      order: [{ field: 'id', dir: 'asc' as const }],
      limit: 10,
    };
    const queryRes = await app.request(queryPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(queryPath, 'POST', appSecret, queryBody),
      },
      body: JSON.stringify(queryBody),
    });
    expect(queryRes.status).toBe(200);
    const queryJson = await queryRes.json();
    expect(queryJson.rows).toHaveLength(1);
    expect(queryJson.rows[0].name).toBe('North HVAC');

    const legacyPath = `/api/v4/workspaces/${encodeURIComponent(OWNER)}/apps/${encodeURIComponent(APP_NPUB)}/db/legacy-check/rows`;
    const legacyPayload = { row_id: 'still-works', data: { ok: true } };
    const legacyRes = await app.request(legacyPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(legacyPath, 'POST', ownerSecret, legacyPayload),
      },
      body: JSON.stringify(legacyPayload),
    });
    expect(legacyRes.status).toBe(201);
  });
});
