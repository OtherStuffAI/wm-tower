import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { config } from '../src/config';
import { setDb } from '../src/db';
import { createApp } from '../src/server';
import {
  createWorkspaceCreditPurchase,
  refreshWorkspaceCreditOrderStatus,
  runHourlyUsageAuditForWorkspace,
} from '../src/services/billing';
import { createWorkspace } from '../src/services/workspaces';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_billing';

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let originalFetch: typeof fetch;
let originalAdminNpub = config.adminNpub;
let originalDirectHttpsUrl = config.directHttpsUrl;
let originalServiceNpub = config.service.npub;
let mockOrderCounter = 0;

const ownerSecret = new Uint8Array(32).fill(11);
const memberSecret = new Uint8Array(32).fill(12);
const adminSecret = new Uint8Array(32).fill(13);
const disabledOwnerSecret = new Uint8Array(32).fill(14);
const outsiderSecret = new Uint8Array(32).fill(15);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const ADMIN_MEMBER = nip19.npubEncode(getPublicKey(adminSecret));
const DISABLED_OWNER = nip19.npubEncode(getPublicKey(disabledOwnerSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));

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

function workspaceInput(workspaceOwnerNpub: string, suffix: string, adminMembers = [OWNER]) {
  return {
    workspace_owner_npub: workspaceOwnerNpub,
    name: `Billing ${suffix}`,
    wrapped_workspace_nsec: `wrapped-workspace-${suffix}`,
    wrapped_by_npub: OWNER,
    default_group_npub: `npub1default${suffix}`,
    default_group_member_keys: [
      { member_npub: OWNER, wrapped_group_nsec: `wrapped-default-owner-${suffix}`, wrapped_by_npub: OWNER },
      { member_npub: MEMBER, wrapped_group_nsec: `wrapped-default-member-${suffix}`, wrapped_by_npub: OWNER },
    ],
    admin_group_npub: `npub1admin${suffix}`,
    admin_group_member_keys: adminMembers.map((member) => ({
      member_npub: member,
      wrapped_group_nsec: `wrapped-admin-${member.slice(-6)}-${suffix}`,
      wrapped_by_npub: OWNER,
    })),
    private_group_npub: `npub1private${suffix}`,
    private_group_member_keys: [
      { member_npub: OWNER, wrapped_group_nsec: `wrapped-private-owner-${suffix}`, wrapped_by_npub: OWNER },
    ],
  };
}

async function createTestWorkspace(workspaceOwnerNpub: string, suffix: string, adminMembers = [OWNER]) {
  return createWorkspace(workspaceInput(workspaceOwnerNpub, suffix, adminMembers), OWNER);
}

function mockMginx(status = 'paid') {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/products/')) {
      return Response.json({ id: 'credits-v1', priceSats: 3, metadata: { unit: 'MB-hour' } });
    }
    if (url.endsWith('/api/orders') && init?.method === 'POST') {
      const id = `mginx-order-${++mockOrderCounter}`;
      return Response.json({
        id,
        invoice: 'lnbc-test',
        amount_sats: 300,
        status: 'pending',
        expires_at: '2026-04-29T01:00:00.000Z',
      });
    }
    if (url.includes('/api/orders/') && url.endsWith('/status')) {
      const id = decodeURIComponent(url.split('/api/orders/')[1]?.split('/status')[0] || '');
      return Response.json({
        id,
        invoice: 'lnbc-test',
        amount_sats: 300,
        status,
        expires_at: '2026-04-29T01:00:00.000Z',
      });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  originalFetch = globalThis.fetch;
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

beforeEach(() => {
  config.adminNpub = ADMIN_MEMBER;
  config.billing.mode = 'metered';
  config.billing.graceDays = 21;
  config.billing.initialGrantCredits = 10;
  config.billing.lowBalanceThresholdCredits = 3;
  config.billing.mginxUrl = 'https://proxy.example.invalid';
  config.billing.mginxApiKey = 'test-key';
  config.billing.creditsProductId = 'credits-v1';
  config.directHttpsUrl = 'https://tower.example.invalid';
  config.service.npub = 'npub1towerdescriptor';
  mockMginx();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.adminNpub = originalAdminNpub;
  config.directHttpsUrl = originalDirectHttpsUrl;
  config.service.npub = originalServiceNpub;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (sql) await sql.end();
});

describe('Superbased billing foundations', () => {
  test('workspace creation creates a workspace credit account with the configured initial grant', async () => {
    config.billing.initialGrantCredits = 42;
    const workspaceOwner = 'npub1billinggrantworkspace';
    await createTestWorkspace(workspaceOwner, 'grant');

    const [account] = await sql<{ balance_credits: string; billing_state: string }[]>`
      SELECT balance_credits::text, billing_state
      FROM workspace_credit_accounts
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;
    expect(account.balance_credits).toBe('42.000000');
    expect(account.billing_state).toBe('active');

    const [grant] = await sql<{ amount_credits: string; type: string }[]>`
      SELECT amount_credits::text, type
      FROM workspace_credit_transactions
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;
    expect(grant.type).toBe('migration_grant');
    expect(grant.amount_credits).toBe('42.000000');
  });

  test('hourly audits round billable usage up and charge each workspace once per hour', async () => {
    const workspaceOwner = 'npub1billingauditworkspace';
    await createTestWorkspace(workspaceOwner, 'audit');

    const [record] = await sql<{ id: string }[]>`
      INSERT INTO v4_records (
        record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
      )
      VALUES (${`record-audit`}, ${workspaceOwner}, ${'family-audit'}, 1, 0, ${OWNER}, ${'a'.repeat(700000)})
      RETURNING id
    `;
    await sql`
      INSERT INTO v4_record_group_payloads (record_row_id, group_npub, ciphertext, can_write)
      VALUES (${record.id}, ${'npub1auditgroup'}, ${'b'.repeat(200000)}, false)
    `;
    await sql`
      INSERT INTO v4_storage_objects (
        owner_npub, created_by_npub, content_type, size_bytes, storage_path, completed_at
      )
      VALUES (${workspaceOwner}, ${OWNER}, ${'text/plain'}, ${200000}, ${'v4/audit/object'}, NOW())
    `;

    const hour = new Date('2026-04-29T10:35:00.000Z');
    const first = await runHourlyUsageAuditForWorkspace(workspaceOwner, hour);
    const second = await runHourlyUsageAuditForWorkspace(workspaceOwner, hour);

    expect(first?.credits_charged).toBe('2.000000');
    expect(second).toBeNull();

    const [account] = await sql<{ balance_credits: string }[]>`
      SELECT balance_credits::text
      FROM workspace_credit_accounts
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;
    expect(account.balance_credits).toBe('8.000000');

    const [auditCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM workspace_usage_hourly_audits
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;
    expect(auditCount.count).toBe('1');
  });

  test('paid order status credits a workspace exactly once when polled repeatedly', async () => {
    const workspaceOwner = 'npub1billingpurchaseworkspace';
    await createTestWorkspace(workspaceOwner, 'purchase');
    const order = await createWorkspaceCreditPurchase(workspaceOwner, OWNER, 100);

    const first = await refreshWorkspaceCreditOrderStatus(workspaceOwner, order.id);
    const second = await refreshWorkspaceCreditOrderStatus(workspaceOwner, order.id);
    expect(first?.status).toBe('paid');
    expect(second?.status).toBe('paid');

    const [account] = await sql<{ balance_credits: string }[]>`
      SELECT balance_credits::text
      FROM workspace_credit_accounts
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;
    expect(account.balance_credits).toBe('110.000000');

    const [purchases] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM workspace_credit_transactions
      WHERE workspace_owner_npub = ${workspaceOwner}
        AND type = 'purchase'
    `;
    expect(purchases.count).toBe('1');
  });

  test('billing status and usage APIs expose rounded usage and only manageable workspaces', async () => {
    const managedWorkspace = 'npub1billingmanagedworkspace';
    const memberWorkspace = 'npub1billingmemberworkspace';
    await createTestWorkspace(managedWorkspace, 'managed', [OWNER, ADMIN_MEMBER]);
    await createTestWorkspace(memberWorkspace, 'member-only', [OWNER]);

    const [record] = await sql<{ id: string }[]>`
      INSERT INTO v4_records (
        record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
      )
      VALUES (${`record-managed-1`}, ${managedWorkspace}, ${'family-managed'}, 1, 0, ${OWNER}, ${'x'.repeat(3)})
      RETURNING id
    `;
    await sql`
      INSERT INTO v4_record_group_payloads (record_row_id, group_npub, ciphertext, can_write)
      VALUES (${record.id}, ${'npub1managedgroup'}, ${'y'.repeat(4)}, false)
    `;

    const statusPath = `/api/v4/workspaces/${encodeURIComponent(managedWorkspace)}/billing/status`;
    const statusRes = await app.request(statusPath, {
      headers: { Authorization: authHeader(statusPath, 'GET', adminSecret) },
    });
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.billing_mode).toBe('metered');
    expect(status.billing_state).toBe('active');
    expect(status.usage.record_bytes).toBe(7);
    expect(status.usage.estimated_credits_per_hour).toBe('1.000000');

    const summaryPath = `/api/v4/billing/workspaces`;
    const summaryRes = await app.request(summaryPath, {
      headers: { Authorization: authHeader(summaryPath, 'GET', memberSecret) },
    });
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json();
    expect(summary.workspaces.some((entry: any) => entry.workspace_owner_npub === memberWorkspace)).toBe(false);
  });

  test('workspace managers can inspect record and storage metadata without decrypted payloads', async () => {
    const workspaceOwner = 'npub1billinginspectworkspace';
    await createTestWorkspace(workspaceOwner, 'inspect', [OWNER, ADMIN_MEMBER]);

    const [record] = await sql<{ id: string }[]>`
      INSERT INTO v4_records (
        record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
      )
      VALUES (${`inspect-record`}, ${workspaceOwner}, ${'inspect-family'}, 1, 0, ${OWNER}, ${'owner-secret'})
      RETURNING id
    `;
    await sql`
      INSERT INTO v4_record_group_payloads (record_row_id, group_npub, ciphertext, can_write)
      VALUES (${record.id}, ${'npub1inspectgroup'}, ${'group-secret'}, false)
    `;
    await sql`
      INSERT INTO v4_storage_objects (
        owner_npub, created_by_npub, content_type, size_bytes, storage_path, is_public, completed_at
      )
      VALUES (${workspaceOwner}, ${OWNER}, ${'application/octet-stream'}, ${1234}, ${'v4/inspect/object'}, true, NOW())
    `;

    const recordsPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/records/metadata`;
    const recordsRes = await app.request(recordsPath, {
      headers: { Authorization: authHeader(recordsPath, 'GET', adminSecret) },
    });
    expect(recordsRes.status).toBe(200);
    const recordsBody = await recordsRes.json();
    expect(recordsBody.records[0].record_id).toBe('inspect-record');
    expect(recordsBody.records[0].owner_ciphertext_bytes).toBe(12);
    expect(recordsBody.records[0].group_payload_count).toBe(1);
    expect(recordsBody.records[0].owner_payload).toBeUndefined();

    const storagePath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/storage/metadata?public=true&completed=true`;
    const storageRes = await app.request(storagePath, {
      headers: { Authorization: authHeader(storagePath, 'GET', adminSecret) },
    });
    expect(storageRes.status).toBe(200);
    const storageBody = await storageRes.json();
    expect(storageBody.objects[0].size_bytes).toBe(1234);
    expect(storageBody.objects[0].is_public).toBe(true);

    const memberRes = await app.request(recordsPath, {
      headers: { Authorization: authHeader(recordsPath, 'GET', memberSecret) },
    });
    expect(memberRes.status).toBe(403);
  });

  test('Tower admin can delete one workspace database footprint', async () => {
    const workspaceOwner = 'npub1billingdeleteworkspace';
    const created = await createTestWorkspace(workspaceOwner, 'delete', [OWNER, ADMIN_MEMBER]);

    const [record] = await sql<{ id: string }[]>`
      INSERT INTO v4_records (
        record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
      )
      VALUES (${`delete-record`}, ${workspaceOwner}, ${'delete-family'}, 1, 0, ${OWNER}, ${'delete-owner-secret'})
      RETURNING id
    `;
    await sql`
      INSERT INTO v4_record_group_payloads (record_row_id, group_id, group_npub, ciphertext, can_write)
      VALUES (${record.id}, ${created.defaultGroup.id}, ${created.defaultGroup.group_npub}, ${'delete-group-secret'}, false)
    `;
    await sql`
      INSERT INTO v4_storage_objects (
        owner_npub, owner_group_id, created_by_npub, content_type, size_bytes, storage_path, completed_at
      )
      VALUES (${workspaceOwner}, ${created.defaultGroup.id}, ${OWNER}, ${'application/octet-stream'}, ${456}, ${'v4/delete/object'}, NOW())
    `;
    await sql`
      INSERT INTO user_profiles (user_npub, display_name)
      VALUES (${OWNER}, ${'Owner'})
      ON CONFLICT (user_npub) DO NOTHING
    `;
    await sql`
      INSERT INTO user_workspace_keys (user_npub, workspace_owner_npub, ws_key_npub)
      VALUES (${OWNER}, ${workspaceOwner}, ${'npub1deleteworkspacekey'})
    `;
    await sql`
      INSERT INTO flightdeck_pg_workspaces (
        tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, description, v4_workspace_id
      )
      VALUES (${config.service.npub}, ${'npub1deletefdpgservice'}, ${workspaceOwner}, ${'flightdeck_pg'}, ${'Delete PG'}, ${'delete'}, ${created.workspace.id})
    `;

    const path = `/api/v4/admin/workspaces/${created.workspace.id}`;
    const body = {
      confirmation: workspaceOwner,
      delete_flightdeck_pg: true,
      delete_storage_metadata: true,
    };
    const res = await app.request(path, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(path, 'DELETE', adminSecret, body),
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.workspace.workspace_owner_npub).toBe(workspaceOwner);
    expect(payload.deleted.v4_workspaces).toBe(1);
    expect(payload.deleted.v4_records).toBe(1);
    expect(payload.deleted.v4_record_group_payloads).toBe(1);
    expect(payload.deleted.v4_storage_objects).toBe(1);
    expect(payload.deleted.flightdeck_pg_workspaces).toBe(1);
    expect(payload.note).toContain('Object-storage blobs were not removed');

    const [remaining] = await sql<{
      workspaces: string;
      records: string;
      storage: string;
      groups: string;
      keys: string;
      fdpg: string;
    }[]>`
      SELECT
        (SELECT COUNT(*)::text FROM v4_workspaces WHERE id = ${created.workspace.id}) AS workspaces,
        (SELECT COUNT(*)::text FROM v4_records WHERE owner_npub = ${workspaceOwner}) AS records,
        (SELECT COUNT(*)::text FROM v4_storage_objects WHERE owner_npub = ${workspaceOwner}) AS storage,
        (SELECT COUNT(*)::text FROM v4_groups WHERE owner_npub = ${workspaceOwner}) AS groups,
        (SELECT COUNT(*)::text FROM user_workspace_keys WHERE workspace_owner_npub = ${workspaceOwner}) AS keys,
        (SELECT COUNT(*)::text FROM flightdeck_pg_workspaces WHERE workspace_owner_npub = ${workspaceOwner}) AS fdpg
    `;
    expect(remaining.workspaces).toBe('0');
    expect(remaining.records).toBe('0');
    expect(remaining.storage).toBe('0');
    expect(remaining.groups).toBe('0');
    expect(remaining.keys).toBe('0');
    expect(remaining.fdpg).toBe('0');
  });

  test('Tower admin can preview and bulk delete multiple workspace database footprints', async () => {
    const firstOwner = 'npub1billingbulkdeleteone';
    const secondOwner = 'npub1billingbulkdeletetwo';
    const first = await createTestWorkspace(firstOwner, 'bulkdeleteone', [OWNER, ADMIN_MEMBER]);
    const second = await createTestWorkspace(secondOwner, 'bulkdeletetwo', [OWNER, ADMIN_MEMBER]);

    for (const entry of [
      { owner: firstOwner, created: first, suffix: 'one' },
      { owner: secondOwner, created: second, suffix: 'two' },
    ]) {
      const [record] = await sql<{ id: string }[]>`
        INSERT INTO v4_records (
          record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
        )
        VALUES (${`bulk-delete-record-${entry.suffix}`}, ${entry.owner}, ${`bulk-delete-family-${entry.suffix}`}, 1, 0, ${OWNER}, ${`bulk-delete-owner-secret-${entry.suffix}`})
        RETURNING id
      `;
      await sql`
        INSERT INTO v4_record_group_payloads (record_row_id, group_id, group_npub, ciphertext, can_write)
        VALUES (${record.id}, ${entry.created.defaultGroup.id}, ${entry.created.defaultGroup.group_npub}, ${`bulk-delete-group-secret-${entry.suffix}`}, false)
      `;
      await sql`
        INSERT INTO v4_storage_objects (
          owner_npub, owner_group_id, created_by_npub, content_type, size_bytes, storage_path, completed_at
        )
        VALUES (${entry.owner}, ${entry.created.defaultGroup.id}, ${OWNER}, ${'application/octet-stream'}, ${789}, ${`v4/bulk-delete/${entry.suffix}`}, NOW())
      `;
      await sql`
        INSERT INTO user_workspace_keys (user_npub, workspace_owner_npub, ws_key_npub)
        VALUES (${OWNER}, ${entry.owner}, ${`npub1bulkdeleteworkspacekey${entry.suffix}`})
      `;
    }

    const workspaceIds = [first.workspace.id, second.workspace.id];
    const previewPath = '/api/v4/admin/workspaces/delete-preview';
    const previewBody = {
      workspace_ids: workspaceIds,
      delete_flightdeck_pg: true,
      delete_storage_metadata: true,
    };
    const previewRes = await app.request(previewPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(previewPath, 'POST', adminSecret, previewBody),
      },
      body: JSON.stringify(previewBody),
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();
    expect(preview.selected_count).toBe(2);
    expect(preview.confirmation_required).toBe('DELETE 2 WORKSPACES');
    expect(preview.totals.before.v4_workspaces).toBe(2);
    expect(preview.totals.before.v4_records).toBe(2);
    expect(preview.totals.before.v4_storage_objects).toBe(2);

    const deletePath = '/api/v4/admin/workspaces/bulk-delete';
    const deleteBody = {
      ...previewBody,
      confirmation: 'DELETE 2 WORKSPACES',
    };
    const deleteRes = await app.request(deletePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(deletePath, 'POST', adminSecret, deleteBody),
      },
      body: JSON.stringify(deleteBody),
    });

    expect(deleteRes.status).toBe(200);
    const payload = await deleteRes.json();
    expect(payload.selected_count).toBe(2);
    expect(payload.totals.deleted.v4_workspaces).toBe(2);
    expect(payload.totals.deleted.v4_records).toBe(2);
    expect(payload.totals.deleted.v4_record_group_payloads).toBe(2);
    expect(payload.totals.deleted.v4_storage_objects).toBe(2);
    expect(payload.totals.deleted.user_workspace_keys).toBe(2);

    const [remaining] = await sql<{
      workspaces: string;
      records: string;
      storage: string;
      groups: string;
      keys: string;
    }[]>`
      SELECT
        (SELECT COUNT(*)::text FROM v4_workspaces WHERE id IN ${sql(workspaceIds)}) AS workspaces,
        (SELECT COUNT(*)::text FROM v4_records WHERE owner_npub IN ${sql([firstOwner, secondOwner])}) AS records,
        (SELECT COUNT(*)::text FROM v4_storage_objects WHERE owner_npub IN ${sql([firstOwner, secondOwner])}) AS storage,
        (SELECT COUNT(*)::text FROM v4_groups WHERE owner_npub IN ${sql([firstOwner, secondOwner])}) AS groups,
        (SELECT COUNT(*)::text FROM user_workspace_keys WHERE workspace_owner_npub IN ${sql([firstOwner, secondOwner])}) AS keys
    `;
    expect(remaining.workspaces).toBe('0');
    expect(remaining.records).toBe('0');
    expect(remaining.storage).toBe('0');
    expect(remaining.groups).toBe('0');
    expect(remaining.keys).toBe('0');
  });

  test('workspace app schema manifests are encrypted, indexed by app, and visible to wrapped groups', async () => {
    const workspaceOwner = 'npub1billingschemaworkspace';
    const created = await createTestWorkspace(workspaceOwner, 'schema');
    const appNpub = 'npub1flightdeckschemaapp';
    const publishPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(appNpub)}/schemas`;
    const publishBody = {
      app_name: 'Flight Deck',
      schema_hash: 'schema-bundle-hash-1',
      schema_version: 1,
      record_families: [
        {
          record_family_hash: `${appNpub}:task`,
          collection_space: 'task',
          schema_version: 1,
          title: 'Task',
        },
      ],
      owner_payload: { ciphertext: 'encrypted-owner-schema-bundle' },
      group_payloads: [
        {
          group_id: created.defaultGroup.id,
          group_epoch: 1,
          group_npub: created.defaultGroup.group_npub,
          ciphertext: 'encrypted-default-group-schema-bundle',
          write: false,
        },
      ],
    };

    const publishRes = await app.request(publishPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(publishPath, 'POST', ownerSecret, publishBody),
      },
      body: JSON.stringify(publishBody),
    });
    expect(publishRes.status).toBe(201);
    const publishJson = await publishRes.json();
    expect(publishJson.schema.app_npub).toBe(appNpub);
    expect(publishJson.schema.record_families[0].record_family_hash).toBe(`${appNpub}:task`);
    expect(publishJson.schema.group_payloads[0].group_id).toBe(created.defaultGroup.id);

    const listPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/app-schemas`;
    const memberRes = await app.request(listPath, {
      headers: { Authorization: authHeader(listPath, 'GET', memberSecret) },
    });
    expect(memberRes.status).toBe(200);
    const memberJson = await memberRes.json();
    expect(memberJson.schemas).toHaveLength(1);
    expect(memberJson.schemas[0].owner_payload.ciphertext).toBe('encrypted-owner-schema-bundle');
    expect(memberJson.schemas[0].group_payloads[0].ciphertext).toBe('encrypted-default-group-schema-bundle');

    const appSchemasPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(appNpub)}/schemas`;
    const appSchemasRes = await app.request(appSchemasPath, {
      headers: { Authorization: authHeader(appSchemasPath, 'GET', memberSecret) },
    });
    expect(appSchemasRes.status).toBe(200);
    expect((await appSchemasRes.json()).schemas[0].schema_hash).toBe('schema-bundle-hash-1');
  });

  test('workspace app descriptor reports installed schema capabilities without credentials or encrypted payloads', async () => {
    const workspaceOwner = 'npub1billingdescriptorworkspace';
    const created = await createTestWorkspace(workspaceOwner, 'descriptor');
    const appNpub = 'npub1flightdeckdescriptorapp';
    const otherAppNpub = 'npub1otherdescriptorapp';
    const publishPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(appNpub)}/schemas`;
    const publishBody = {
      app_name: 'Flight Deck PG',
      schema_hash: 'flightdeck-pg-schema-hash-2',
      schema_version: 2,
      capabilities: ['pg_scopes', 'pg_tasks', 'realtime_events'],
      record_families: [
        { record_family_hash: `${appNpub}:scope`, collection_space: 'scope', schema_version: 2 },
        { record_family_hash: `${appNpub}:task`, collection_space: 'task', schema_version: 2 },
      ],
      owner_payload: { ciphertext: 'encrypted-owner-flightdeck-schema' },
      group_payloads: [
        {
          group_id: created.defaultGroup.id,
          group_epoch: 1,
          group_npub: created.defaultGroup.group_npub,
          ciphertext: 'encrypted-group-flightdeck-schema',
          write: true,
        },
      ],
    };
    const publishRes = await app.request(publishPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(publishPath, 'POST', ownerSecret, publishBody),
      },
      body: JSON.stringify(publishBody),
    });
    expect(publishRes.status).toBe(201);

    const otherPublishPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(otherAppNpub)}/schemas`;
    const otherPublishBody = {
      app_name: 'Other App',
      schema_hash: 'other-schema-hash-1',
      schema_version: 9,
      capabilities: ['pg_chat'],
      record_families: [{ record_family_hash: `${otherAppNpub}:chat`, collection_space: 'chat', schema_version: 9 }],
      owner_payload: { ciphertext: 'encrypted-other-owner-schema' },
    };
    const otherPublishRes = await app.request(otherPublishPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(otherPublishPath, 'POST', ownerSecret, otherPublishBody),
      },
      body: JSON.stringify(otherPublishBody),
    });
    expect(otherPublishRes.status).toBe(201);

    const descriptorPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(appNpub)}/descriptor`;
    const descriptorRes = await app.request(descriptorPath, {
      headers: { Authorization: authHeader(descriptorPath, 'GET', memberSecret) },
    });
    expect(descriptorRes.status).toBe(200);
    const body = await descriptorRes.json();
    expect(body.viewer).toBe(MEMBER);
    expect(body.descriptor).toMatchObject({
      type: 'wingman_workspace_locator',
      version: 1,
      installed: true,
      enabled: true,
      app_npub: appNpub,
      app_name: 'Flight Deck PG',
      tower_base_url: 'https://tower.example.invalid',
      tower_service_npub: 'npub1towerdescriptor',
      service_npub: 'npub1towerdescriptor',
      workspace_service_npub: workspaceOwner,
      workspace_owner_npub: workspaceOwner,
      schema_version: 2,
      schema_hash: 'flightdeck-pg-schema-hash-2',
      capabilities: ['pg_scopes', 'pg_tasks', 'realtime_events'],
    });
    expect(body.descriptor.workspace_id).toBe(created.workspace.id);
    expect(body.descriptor.app_npub).not.toBe(MEMBER);
    expect(body.descriptor.capabilities).not.toContain('pg_chat');
    expect(body.descriptor).not.toHaveProperty('connection_token');
    expect(body.descriptor).not.toHaveProperty('agent_connect_package');
    expect(body.descriptor).not.toHaveProperty('owner_payload');
    expect(body.descriptor).not.toHaveProperty('group_payloads');
    expect(JSON.stringify(body.descriptor)).not.toMatch(/password|postgres|ciphertext|encrypted-owner-flightdeck-schema|encrypted-group-flightdeck-schema/i);

    const outsiderRes = await app.request(descriptorPath, {
      headers: { Authorization: authHeader(descriptorPath, 'GET', outsiderSecret) },
    });
    expect(outsiderRes.status).toBe(403);
    expect(OUTSIDER).not.toBe(MEMBER);
  });

  test('workspace app descriptor handles uninstalled and disabled app namespaces', async () => {
    const workspaceOwner = 'npub1billingdescriptorinactiveworkspace';
    const created = await createTestWorkspace(workspaceOwner, 'descriptorinactive');
    const missingAppNpub = 'npub1missingdescriptorapp';
    const missingPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(missingAppNpub)}/descriptor`;
    const missingRes = await app.request(missingPath, {
      headers: { Authorization: authHeader(missingPath, 'GET', ownerSecret) },
    });
    expect(missingRes.status).toBe(200);
    const missing = await missingRes.json();
    expect(missing.descriptor).toMatchObject({
      installed: false,
      enabled: false,
      app_npub: missingAppNpub,
      app_name: null,
      workspace_owner_npub: workspaceOwner,
      workspace_service_npub: workspaceOwner,
      workspace_id: created.workspace.id,
      schema_version: null,
      schema_hash: null,
      capabilities: [],
    });

    const appNpub = 'npub1disableddescriptorapp';
    await sql`
      INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, enabled, capabilities, created_by_npub)
      VALUES (${workspaceOwner}, ${appNpub}, ${'Disabled Flight Deck'}, false, ${sql.json(['pg_tasks'])}, ${OWNER})
    `;
    await sql`
      INSERT INTO workspace_app_schema_manifests (
        workspace_owner_npub,
        app_npub,
        schema_hash,
        schema_version,
        record_families,
        owner_ciphertext,
        created_by_npub
      )
      VALUES (
        ${workspaceOwner},
        ${appNpub},
        ${'disabled-schema-hash'},
        3,
        ${sql.json([{ record_family_hash: `${appNpub}:task`, collection_space: 'task', schema_version: 3 }])},
        ${'encrypted-disabled-owner-schema'},
        ${OWNER}
      )
    `;
    const disabledPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(appNpub)}/descriptor`;
    const disabledRes = await app.request(disabledPath, {
      headers: { Authorization: authHeader(disabledPath, 'GET', ownerSecret) },
    });
    expect(disabledRes.status).toBe(200);
    const disabled = await disabledRes.json();
    expect(disabled.descriptor).toMatchObject({
      installed: true,
      enabled: false,
      app_npub: appNpub,
      app_name: 'Disabled Flight Deck',
      schema_version: 3,
      schema_hash: 'disabled-schema-hash',
      capabilities: [],
    });
  });

  test('workspace admins can purchase and see ledger; non-admin members cannot', async () => {
    const workspaceOwner = 'npub1billingauthworkspace';
    await createTestWorkspace(workspaceOwner, 'auth', [OWNER, ADMIN_MEMBER]);

    const purchaseBody = { quantity_credits: 5 };
    const purchasePath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/billing/purchase`;
    const purchaseRes = await app.request(purchasePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(purchasePath, 'POST', adminSecret, purchaseBody),
      },
      body: JSON.stringify(purchaseBody),
    });
    expect(purchaseRes.status).toBe(201);
    const purchase = await purchaseRes.json();
    expect(purchase.invoice).toBe('lnbc-test');
    expect(purchase.expires_at).toBe('2026-04-29T01:00:00.000Z');

    const ledgerPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/billing/transactions`;
    const ledgerRes = await app.request(ledgerPath, {
      headers: { Authorization: authHeader(ledgerPath, 'GET', adminSecret) },
    });
    expect(ledgerRes.status).toBe(200);

    const memberPurchaseRes = await app.request(purchasePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(purchasePath, 'POST', memberSecret, purchaseBody),
      },
      body: JSON.stringify(purchaseBody),
    });
    expect(memberPurchaseRes.status).toBe(403);

    const memberLedgerRes = await app.request(ledgerPath, {
      headers: { Authorization: authHeader(ledgerPath, 'GET', memberSecret) },
    });
    expect(memberLedgerRes.status).toBe(403);
  });

  test('read-only grace blocks writes, storage uploads, and public connection tokens but still allows reads', async () => {
    const workspaceOwner = OWNER;
    await createTestWorkspace(workspaceOwner, 'grace');
    await sql`
      UPDATE workspace_credit_accounts
      SET balance_credits = 0,
          billing_state = 'read_only_grace',
          depleted_at = NOW(),
          delete_eligible_at = NOW() + INTERVAL '21 days'
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;

    const syncBody = {
      owner_npub: workspaceOwner,
      records: [{
        record_id: 'blocked-record',
        owner_npub: workspaceOwner,
        record_family_hash: 'blocked-family',
        version: 1,
        previous_version: 0,
        signature_npub: OWNER,
        owner_payload: { ciphertext: 'blocked' },
      }],
    };
    const syncRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, syncBody),
      },
      body: JSON.stringify(syncBody),
    });
    expect(syncRes.status).toBe(402);
    expect((await syncRes.json()).code).toBe('insufficient_credits');

    const storageBody = { owner_npub: workspaceOwner, content_type: 'text/plain', size_bytes: 10 };
    const storageRes = await app.request('/api/v4/storage/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/storage/prepare', 'POST', ownerSecret, storageBody),
      },
      body: JSON.stringify(storageBody),
    });
    expect(storageRes.status).toBe(402);

    const appCreateBody = { app_npub: 'npub1blockedapp', app_name: 'Blocked App' };
    const appsPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps`;
    await app.request(appsPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(appsPath, 'POST', ownerSecret, appCreateBody),
      },
      body: JSON.stringify(appCreateBody),
    });
    const tokenPath = `/api/v4/workspaces/${encodeURIComponent(workspaceOwner)}/apps/${encodeURIComponent(appCreateBody.app_npub)}/connection-token`;
    const tokenRes = await app.request(tokenPath, {
      headers: { Authorization: authHeader(tokenPath, 'GET', ownerSecret) },
    });
    expect(tokenRes.status).toBe(402);

    await sql`
      INSERT INTO v4_records (
        record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
      )
      VALUES (${'readable-record'}, ${workspaceOwner}, ${'readable-family'}, 1, 0, ${OWNER}, ${'readable'})
    `;
    const readPath = `/api/v4/records?owner_npub=${encodeURIComponent(workspaceOwner)}&record_family_hash=readable-family`;
    const readRes = await app.request(readPath, {
      headers: { Authorization: authHeader(readPath, 'GET', ownerSecret) },
    });
    expect(readRes.status).toBe(200);
  });

  test('admin billing overview marks expired grace workspaces delete_eligible without deleting data', async () => {
    const workspaceOwner = 'npub1billingdeleteeligibleworkspace';
    await createTestWorkspace(workspaceOwner, 'delete-eligible');
    await sql`
      UPDATE workspace_credit_accounts
      SET balance_credits = -1,
          billing_state = 'read_only_grace',
          depleted_at = NOW() - INTERVAL '30 days',
          delete_eligible_at = NOW() - INTERVAL '1 day'
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;
    await sql`
      INSERT INTO v4_records (
        record_id, owner_npub, record_family_hash, version, previous_version, signature_npub, owner_ciphertext
      )
      VALUES (${'delete-eligible-record'}, ${workspaceOwner}, ${'delete-eligible-family'}, 1, 0, ${OWNER}, ${'still-here'})
    `;

    const overviewPath = '/api/v4/admin/billing/overview';
    const overviewRes = await app.request(overviewPath, {
      headers: { Authorization: authHeader(overviewPath, 'GET', adminSecret) },
    });
    expect(overviewRes.status).toBe(200);
    const overview = await overviewRes.json();
    expect(overview.counts.delete_eligible).toBeGreaterThanOrEqual(1);
    expect(overview.at_risk_workspaces.some((entry: any) => entry.workspace_owner_npub === workspaceOwner && entry.billing_state === 'delete_eligible')).toBe(true);

    const [recordCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM v4_records
      WHERE owner_npub = ${workspaceOwner}
    `;
    expect(recordCount.count).toBe('1');
  });

  test('disabled billing mode does not deduct credits or block writes', async () => {
    config.billing.mode = 'disabled';
    const workspaceOwner = 'npub1disabledworkspace';
    await createTestWorkspace(workspaceOwner, 'disabled');
    await sql`
      UPDATE workspace_credit_accounts
      SET balance_credits = 0,
          billing_state = 'read_only_grace'
      WHERE workspace_owner_npub = ${workspaceOwner}
    `;

    const audit = await runHourlyUsageAuditForWorkspace(workspaceOwner, new Date('2026-04-29T11:00:00.000Z'));
    expect(audit).toBeNull();

    const ownerWorkspace = DISABLED_OWNER;
    await createTestWorkspace(ownerWorkspace, 'disabled-write');
    await sql`
      UPDATE workspace_credit_accounts
      SET balance_credits = 0,
          billing_state = 'read_only_grace'
      WHERE workspace_owner_npub = ${ownerWorkspace}
    `;

    const syncBody = {
      owner_npub: ownerWorkspace,
      records: [{
        record_id: 'disabled-record',
        owner_npub: ownerWorkspace,
        record_family_hash: 'disabled-family',
        version: 1,
        previous_version: 0,
        signature_npub: DISABLED_OWNER,
        owner_payload: { ciphertext: 'disabled-ok' },
      }],
    };
    const syncRes = await app.request('/api/v4/records/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/records/sync', 'POST', disabledOwnerSecret, syncBody),
      },
      body: JSON.stringify(syncBody),
    });
    expect(syncRes.status).toBe(200);
  });
});
