/**
 * Scope Lineage Compatibility Tests
 *
 * Validates that Tower is fully compatible with the canonical scope lineage
 * model (l1_id–l5_id / scope_l1_id–scope_l5_id) described in
 * docs/design/scope-levels-l1-l5.md.
 *
 * Tower is payload-agnostic: it stores owner_ciphertext and group ciphertext
 * as opaque strings without inspecting content. These tests prove that:
 *
 * 1. Records with canonical scope lineage payloads sync and fetch correctly
 * 2. Records with canonical scoped-record payloads sync and fetch correctly
 * 3. Migrated records (legacy → canonical payload update) sync via version chain
 * 4. Mixed payload shapes coexist without issues
 * 5. All five depth levels round-trip through sync/fetch/summary/heartbeat
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { setDb } from '../src/db';
import { createApp } from '../src/server';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_scope_lineage';

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
  if (sql) await sql.end();
});

// --- Test identities ---
const ownerSecret = new Uint8Array(32).fill(21);
const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const GROUP_NPUB = 'npub1scooperatorst_group_xyz';

// Record family hashes for scope records and scoped records
const SCOPE_FAMILY = 'scope_family_hash_test';
const TASK_FAMILY = 'task_family_hash_test';

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

/**
 * Build a canonical scope payload (what clients will encrypt and store).
 * Tower stores this as opaque ciphertext — we use JSON for test readability.
 */
function buildScopePayload(opts: {
  title: string;
  level: string;
  parent_id: string | null;
  l1_id: string | null;
  l2_id: string | null;
  l3_id: string | null;
  l4_id: string | null;
  l5_id: string | null;
}) {
  return JSON.stringify(opts);
}

/**
 * Build a canonical scoped-record payload (task/doc/etc with scope lineage).
 */
function buildScopedRecordPayload(opts: {
  title: string;
  scope_id: string;
  scope_l1_id: string | null;
  scope_l2_id: string | null;
  scope_l3_id: string | null;
  scope_l4_id: string | null;
  scope_l5_id: string | null;
}) {
  return JSON.stringify(opts);
}

async function syncRecord(recordId: string, family: string, version: number, prevVersion: number, ciphertext: string, groupCiphertext?: string) {
  const payload = {
    owner_npub: OWNER,
    records: [{
      record_id: recordId,
      owner_npub: OWNER,
      record_family_hash: family,
      version,
      previous_version: prevVersion,
      signature_npub: OWNER,
      owner_payload: { ciphertext },
      group_payloads: groupCiphertext ? [{
        group_npub: GROUP_NPUB,
        ciphertext: groupCiphertext,
        write: true,
      }] : [],
    }],
  };
  const res = await app.request('/api/v4/records/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader('/api/v4/records/sync', 'POST', ownerSecret, payload),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function fetchRecords(family: string) {
  const path = `/api/v4/records?owner_npub=${OWNER}&record_family_hash=${family}`;
  const res = await app.request(path, {
    method: 'GET',
    headers: {
      Authorization: authHeader(path, 'GET', ownerSecret),
    },
  });
  return { status: res.status, body: await res.json() };
}

async function fetchSummary(family?: string) {
  const qs = family
    ? `owner_npub=${OWNER}&record_family_hash=${family}`
    : `owner_npub=${OWNER}`;
  const path = `/api/v4/records/summary?${qs}`;
  const res = await app.request(path, {
    method: 'GET',
    headers: {
      Authorization: authHeader(path, 'GET', ownerSecret),
    },
  });
  return { status: res.status, body: await res.json() };
}

async function heartbeat(cursors: Record<string, string | null>) {
  const payload = {
    owner_npub: OWNER,
    family_cursors: cursors,
  };
  const res = await app.request('/api/v4/records/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader('/api/v4/records/heartbeat', 'POST', ownerSecret, payload),
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Scope Lineage Tower Compatibility', () => {

  describe('Canonical scope records (l1_id–l5_id) round-trip', () => {
    const L1_SCOPE_ID = 'scope-l1-compat-001';
    const L2_SCOPE_ID = 'scope-l2-compat-002';
    const L3_SCOPE_ID = 'scope-l3-compat-003';
    const L4_SCOPE_ID = 'scope-l4-compat-004';
    const L5_SCOPE_ID = 'scope-l5-compat-005';

    test('sync L1 scope with canonical lineage', async () => {
      const ct = buildScopePayload({
        title: 'Marketing',
        level: 'l1',
        parent_id: null,
        l1_id: L1_SCOPE_ID,
        l2_id: null, l3_id: null, l4_id: null, l5_id: null,
      });
      const { status, body } = await syncRecord(L1_SCOPE_ID, SCOPE_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
      expect(body.rejected).toHaveLength(0);
    });

    test('sync L2 scope with canonical lineage', async () => {
      const ct = buildScopePayload({
        title: 'Content Production',
        level: 'l2',
        parent_id: L1_SCOPE_ID,
        l1_id: L1_SCOPE_ID,
        l2_id: L2_SCOPE_ID,
        l3_id: null, l4_id: null, l5_id: null,
      });
      const { status, body } = await syncRecord(L2_SCOPE_ID, SCOPE_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('sync L3 scope with canonical lineage', async () => {
      const ct = buildScopePayload({
        title: 'Blog Writing',
        level: 'l3',
        parent_id: L2_SCOPE_ID,
        l1_id: L1_SCOPE_ID,
        l2_id: L2_SCOPE_ID,
        l3_id: L3_SCOPE_ID,
        l4_id: null, l5_id: null,
      });
      const { status, body } = await syncRecord(L3_SCOPE_ID, SCOPE_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('sync L4 scope with canonical lineage', async () => {
      const ct = buildScopePayload({
        title: 'Content Editing',
        level: 'l4',
        parent_id: L3_SCOPE_ID,
        l1_id: L1_SCOPE_ID,
        l2_id: L2_SCOPE_ID,
        l3_id: L3_SCOPE_ID,
        l4_id: L4_SCOPE_ID,
        l5_id: null,
      });
      const { status, body } = await syncRecord(L4_SCOPE_ID, SCOPE_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('sync L5 scope with canonical lineage', async () => {
      const ct = buildScopePayload({
        title: 'Final Review',
        level: 'l5',
        parent_id: L4_SCOPE_ID,
        l1_id: L1_SCOPE_ID,
        l2_id: L2_SCOPE_ID,
        l3_id: L3_SCOPE_ID,
        l4_id: L4_SCOPE_ID,
        l5_id: L5_SCOPE_ID,
      });
      const { status, body } = await syncRecord(L5_SCOPE_ID, SCOPE_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('fetch returns all 5 scope records with payloads intact', async () => {
      const { status, body } = await fetchRecords(SCOPE_FAMILY);
      expect(status).toBe(200);
      expect(body.records).toHaveLength(5);

      // Verify each record's ciphertext is preserved exactly
      const byId = new Map(body.records.map((r: any) => [r.record_id, r]));

      const l1 = byId.get(L1_SCOPE_ID);
      expect(l1).toBeDefined();
      const l1Payload = JSON.parse(l1.owner_payload.ciphertext);
      expect(l1Payload.level).toBe('l1');
      expect(l1Payload.l1_id).toBe(L1_SCOPE_ID);
      expect(l1Payload.l2_id).toBeNull();
      expect(l1Payload.l3_id).toBeNull();
      expect(l1Payload.l4_id).toBeNull();
      expect(l1Payload.l5_id).toBeNull();

      const l5 = byId.get(L5_SCOPE_ID);
      expect(l5).toBeDefined();
      const l5Payload = JSON.parse(l5.owner_payload.ciphertext);
      expect(l5Payload.level).toBe('l5');
      expect(l5Payload.l1_id).toBe(L1_SCOPE_ID);
      expect(l5Payload.l2_id).toBe(L2_SCOPE_ID);
      expect(l5Payload.l3_id).toBe(L3_SCOPE_ID);
      expect(l5Payload.l4_id).toBe(L4_SCOPE_ID);
      expect(l5Payload.l5_id).toBe(L5_SCOPE_ID);
    });

    test('group payloads also preserved for scope records', async () => {
      const { body } = await fetchRecords(SCOPE_FAMILY);
      const l3 = body.records.find((r: any) => r.record_id === L3_SCOPE_ID);
      expect(l3.group_payloads).toHaveLength(1);
      const gp = l3.group_payloads[0];
      expect(gp.group_npub).toBe(GROUP_NPUB);
      const gpPayload = JSON.parse(gp.ciphertext);
      expect(gpPayload.l1_id).toBe(L1_SCOPE_ID);
      expect(gpPayload.l2_id).toBe(L2_SCOPE_ID);
      expect(gpPayload.l3_id).toBe(L3_SCOPE_ID);
    });
  });

  describe('Canonical scoped records (scope_l1_id–scope_l5_id) round-trip', () => {
    const TASK_AT_L3 = 'task-scoped-l3-001';
    const TASK_AT_L5 = 'task-scoped-l5-002';
    const TASK_UNSCOPED = 'task-unscoped-003';

    test('sync task scoped to L3 with canonical lineage tags', async () => {
      const ct = buildScopedRecordPayload({
        title: 'Write blog post',
        scope_id: 'scope-l3-compat-003',
        scope_l1_id: 'scope-l1-compat-001',
        scope_l2_id: 'scope-l2-compat-002',
        scope_l3_id: 'scope-l3-compat-003',
        scope_l4_id: null,
        scope_l5_id: null,
      });
      const { status, body } = await syncRecord(TASK_AT_L3, TASK_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('sync task scoped to L5 with full lineage tags', async () => {
      const ct = buildScopedRecordPayload({
        title: 'Final review check',
        scope_id: 'scope-l5-compat-005',
        scope_l1_id: 'scope-l1-compat-001',
        scope_l2_id: 'scope-l2-compat-002',
        scope_l3_id: 'scope-l3-compat-003',
        scope_l4_id: 'scope-l4-compat-004',
        scope_l5_id: 'scope-l5-compat-005',
      });
      const { status, body } = await syncRecord(TASK_AT_L5, TASK_FAMILY, 1, 0, ct, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('sync unscoped record (all lineage null)', async () => {
      const ct = buildScopedRecordPayload({
        title: 'Inbox task',
        scope_id: '',
        scope_l1_id: null,
        scope_l2_id: null,
        scope_l3_id: null,
        scope_l4_id: null,
        scope_l5_id: null,
      });
      const { status, body } = await syncRecord(TASK_UNSCOPED, TASK_FAMILY, 1, 0, ct);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('fetch returns scoped record payloads intact', async () => {
      const { status, body } = await fetchRecords(TASK_FAMILY);
      expect(status).toBe(200);
      expect(body.records).toHaveLength(3);

      const task = body.records.find((r: any) => r.record_id === TASK_AT_L5);
      const payload = JSON.parse(task.owner_payload.ciphertext);
      expect(payload.scope_l1_id).toBe('scope-l1-compat-001');
      expect(payload.scope_l2_id).toBe('scope-l2-compat-002');
      expect(payload.scope_l3_id).toBe('scope-l3-compat-003');
      expect(payload.scope_l4_id).toBe('scope-l4-compat-004');
      expect(payload.scope_l5_id).toBe('scope-l5-compat-005');
    });
  });

  describe('Migration path: legacy → canonical payload update', () => {
    const MIGRATING_SCOPE = 'scope-migrate-001';
    const MIGRATING_TASK = 'task-migrate-001';

    test('sync legacy scope payload (v1 with product_id/project_id)', async () => {
      const legacyCt = JSON.stringify({
        title: 'Old Deliverable',
        level: 'deliverable',
        parent_id: 'some-project-id',
        product_id: 'some-product-id',
        project_id: 'some-project-id',
      });
      const { status, body } = await syncRecord(MIGRATING_SCOPE, SCOPE_FAMILY, 1, 0, legacyCt);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('update to canonical payload (v2 migration)', async () => {
      const canonicalCt = buildScopePayload({
        title: 'Old Deliverable',
        level: 'l3',
        parent_id: 'some-project-id',
        l1_id: 'some-product-id',
        l2_id: 'some-project-id',
        l3_id: MIGRATING_SCOPE,
        l4_id: null,
        l5_id: null,
      });
      const { status, body } = await syncRecord(MIGRATING_SCOPE, SCOPE_FAMILY, 2, 1, canonicalCt);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.updated).toBe(1);
    });

    test('fetch returns only the canonical v2 payload', async () => {
      const { body } = await fetchRecords(SCOPE_FAMILY);
      const rec = body.records.find((r: any) => r.record_id === MIGRATING_SCOPE);
      expect(rec.version).toBe(2);
      const payload = JSON.parse(rec.owner_payload.ciphertext);
      expect(payload.level).toBe('l3');
      expect(payload.l1_id).toBe('some-product-id');
      expect(payload.l2_id).toBe('some-project-id');
      expect(payload.l3_id).toBe(MIGRATING_SCOPE);
      // Legacy fields should not be present
      expect(payload.product_id).toBeUndefined();
      expect(payload.project_id).toBeUndefined();
    });

    test('record history preserves both legacy and canonical versions', async () => {
      const path = `/api/v4/records/${MIGRATING_SCOPE}/history?owner_npub=${OWNER}`;
      const res = await app.request(path, {
        method: 'GET',
        headers: {
          Authorization: authHeader(path, 'GET', ownerSecret),
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.versions).toHaveLength(2);

      // Newest first
      const v2 = body.versions[0];
      const v1 = body.versions[1];
      expect(v2.version).toBe(2);
      expect(v1.version).toBe(1);

      // v1 has legacy payload
      const v1Payload = JSON.parse(v1.owner_payload.ciphertext);
      expect(v1Payload.product_id).toBe('some-product-id');

      // v2 has canonical payload
      const v2Payload = JSON.parse(v2.owner_payload.ciphertext);
      expect(v2Payload.l1_id).toBe('some-product-id');
    });

    test('sync legacy scoped task then migrate to canonical', async () => {
      // v1: legacy
      const legacyCt = JSON.stringify({
        title: 'Old task',
        scope_id: 'some-scope',
        scope_product_id: 'prod-1',
        scope_project_id: 'proj-1',
        scope_deliverable_id: 'some-scope',
      });
      let result = await syncRecord(MIGRATING_TASK, TASK_FAMILY, 1, 0, legacyCt);
      expect(result.body.synced).toBe(1);

      // v2: canonical
      const canonicalCt = buildScopedRecordPayload({
        title: 'Old task',
        scope_id: 'some-scope',
        scope_l1_id: 'prod-1',
        scope_l2_id: 'proj-1',
        scope_l3_id: 'some-scope',
        scope_l4_id: null,
        scope_l5_id: null,
      });
      result = await syncRecord(MIGRATING_TASK, TASK_FAMILY, 2, 1, canonicalCt);
      expect(result.body.synced).toBe(1);
      expect(result.body.updated).toBe(1);
    });
  });

  describe('Summary and heartbeat with canonical payloads', () => {
    test('summary includes scope family with correct count', async () => {
      const { status, body } = await fetchSummary(SCOPE_FAMILY);
      expect(status).toBe(200);
      // 5 depth levels + 1 migrating scope = 6
      const family = body.families.find((f: any) => f.record_family_hash === SCOPE_FAMILY);
      expect(family).toBeDefined();
      expect(family.latest_record_count).toBe(6);
    });

    test('summary includes task family with correct count', async () => {
      const { status, body } = await fetchSummary(TASK_FAMILY);
      expect(status).toBe(200);
      const family = body.families.find((f: any) => f.record_family_hash === TASK_FAMILY);
      expect(family).toBeDefined();
      // 3 scoped tasks + 1 migrating task = 4
      expect(family.latest_record_count).toBe(4);
    });

    test('heartbeat detects stale families', async () => {
      // Pass a very old cursor to force stale detection
      const { status, body } = await heartbeat({
        [SCOPE_FAMILY]: '2000-01-01T00:00:00Z',
        [TASK_FAMILY]: '2000-01-01T00:00:00Z',
      });
      expect(status).toBe(200);
      expect(body.stale_families).toContain(SCOPE_FAMILY);
      expect(body.stale_families).toContain(TASK_FAMILY);
    });

    test('heartbeat shows up-to-date when cursor is fresh', async () => {
      // First get current server cursors
      const { body: hb1 } = await heartbeat({});
      // Now send those cursors back — should not be stale
      const { body: hb2 } = await heartbeat(hb1.server_cursors);
      expect(hb2.stale_families).not.toContain(SCOPE_FAMILY);
      expect(hb2.stale_families).not.toContain(TASK_FAMILY);
    });
  });

  describe('Payload-agnostic validation', () => {
    test('Tower accepts arbitrary payload content without validation', async () => {
      // Sync a record with completely arbitrary ciphertext (not JSON)
      const { status, body } = await syncRecord(
        'arbitrary-payload-001',
        'arbitrary_family',
        1, 0,
        'this-is-not-json-its-encrypted-binary-blob-base64==',
        'another-encrypted-group-blob=='
      );
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
    });

    test('arbitrary payload round-trips exactly', async () => {
      const { body } = await fetchRecords('arbitrary_family');
      expect(body.records).toHaveLength(1);
      expect(body.records[0].owner_payload.ciphertext).toBe(
        'this-is-not-json-its-encrypted-binary-blob-base64=='
      );
      expect(body.records[0].group_payloads[0].ciphertext).toBe(
        'another-encrypted-group-blob=='
      );
    });

    test('Tower does not inspect or reject based on payload field names', async () => {
      // Record with fields that look like both legacy AND canonical
      const mixedCt = JSON.stringify({
        product_id: 'old',
        l1_id: 'new',
        scope_product_id: 'old',
        scope_l1_id: 'new',
        random_field: 'whatever',
      });
      const { status, body } = await syncRecord('mixed-fields-001', 'mixed_family', 1, 0, mixedCt);
      expect(status).toBe(200);
      expect(body.synced).toBe(1);
    });
  });
});
