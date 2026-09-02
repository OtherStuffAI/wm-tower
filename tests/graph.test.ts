import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_graph_test';
const GRAPH_TEST_DB = process.env.TEST_GRAPH_DB_NAME || 'tower_graph_test';

const ownerSecret = new Uint8Array(32).fill(11);
const memberSecret = new Uint8Array(32).fill(12);
const agentSecret = new Uint8Array(32).fill(13);
const otherAgentSecret = new Uint8Array(32).fill(14);
const outsiderSecret = new Uint8Array(32).fill(15);
const appSecret = new Uint8Array(32).fill(16);

const OWNER = nip19.npubEncode(getPublicKey(ownerSecret));
const MEMBER = nip19.npubEncode(getPublicKey(memberSecret));
const AGENT = nip19.npubEncode(getPublicKey(agentSecret));
const OTHER_AGENT = nip19.npubEncode(getPublicKey(otherAgentSecret));
const OUTSIDER = nip19.npubEncode(getPublicKey(outsiderSecret));
const APP_NPUB = nip19.npubEncode(getPublicKey(appSecret));

let sql: ReturnType<typeof postgres>;
let app: any;
let config: any;
let closeGraphDbs: () => Promise<void>;
let groupId: string;

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

async function importGraphFixture(payload: Record<string, unknown>, secret: Uint8Array = agentSecret) {
  const path = '/api/v4/graph/import-runs';
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(path, 'POST', secret, payload),
    },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function repositoryDelta(payload: Record<string, unknown>, secret: Uint8Array = agentSecret) {
  const path = '/api/v4/graph/repository-deltas';
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(path, 'POST', secret, payload),
    },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json() };
}

async function repositoryCheckpoints(query: string, secret: Uint8Array = agentSecret) {
  const path = `/api/v4/graph/repository-checkpoints?${query}`;
  const res = await app.request(path, { headers: { Authorization: authHeader(path, 'GET', secret) } });
  return { res, body: await res.json() };
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
  process.env.DB_HOST = process.env.DB_HOST || 'localhost';
  process.env.DB_PORT = process.env.DB_PORT || '5432';
  process.env.DB_USER = process.env.DB_USER || 'postgres';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
  process.env.DB_NAME = TEST_DB;
  process.env.GRAPH_ENABLED = 'true';
  process.env.GRAPH_DB_HOST = process.env.DB_HOST;
  process.env.GRAPH_DB_PORT = process.env.DB_PORT;
  process.env.GRAPH_DB_NAME = GRAPH_TEST_DB;
  process.env.GRAPH_DB_ADMIN_USER = process.env.DB_USER;
  process.env.GRAPH_DB_ADMIN_PASSWORD = process.env.DB_PASSWORD;
  process.env.GRAPH_DB_APP_USER = 'tower_graph_app_test';
  process.env.GRAPH_DB_APP_PASSWORD = 'tower_graph_app_test_password';
  process.env.GRAPH_ALLOWED_NPUBS = [OWNER, MEMBER, AGENT, OTHER_AGENT].join(',');

  const admin = postgres({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10),
    database: 'postgres',
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${GRAPH_TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }

  const dbModule = await import('../src/db');
  const serverModule = await import('../src/server');
  const configModule = await import('../src/config');
  const graphMigrationModule = await import('../src/graph/run-migrations');
  const graphDbModule = await import('../src/graph/db');

  config = configModule.config;
  config.graph.enabled = true;
  config.graph.ageGraphName = 'tower_memory';
  config.graph.db.host = process.env.GRAPH_DB_HOST;
  config.graph.db.port = parseInt(process.env.GRAPH_DB_PORT, 10);
  config.graph.db.database = GRAPH_TEST_DB;
  config.graph.db.adminUser = process.env.GRAPH_DB_ADMIN_USER;
  config.graph.db.adminPassword = process.env.GRAPH_DB_ADMIN_PASSWORD;
  config.graph.db.appUser = process.env.GRAPH_DB_APP_USER;
  config.graph.db.appPassword = process.env.GRAPH_DB_APP_PASSWORD;
  config.graph.db.max = 10;
  config.graph.allowedNpubs = [OWNER, MEMBER, AGENT, OTHER_AGENT];
  closeGraphDbs = graphDbModule.closeGraphDbs;

  sql = postgres({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10),
    database: TEST_DB,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  dbModule.setDb(sql);
  await runMainMigration(sql);
  await graphMigrationModule.runGraphMigrations();

  const [group] = await sql<{ id: string }[]>`
    INSERT INTO v4_groups (owner_npub, name, group_npub)
    VALUES (${OWNER}, 'Graph Memory Group', 'npub1graph_group_test')
    RETURNING id
  `;
  groupId = group.id;
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
      'Graph Workspace',
      'wrapped-workspace-key',
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
    VALUES (${OWNER}, ${APP_NPUB}, 'Graph Test App', ${OWNER})
  `;

  app = serverModule.createApp();
});

afterAll(async () => {
  if (closeGraphDbs) await closeGraphDbs();
  if (sql) await sql.end();
});

describe('Graph memory API', () => {
  test('GRAPH_ENABLED=false returns graph_disabled without opening graph DB', async () => {
    config.graph.enabled = false;
    const res = await app.request('/api/v4/graph/memories');
    config.graph.enabled = true;

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe('graph_disabled');
  });

  test('non-allowlisted npubs cannot use graph routes', async () => {
    const path = '/api/v4/graph/memories';
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', outsiderSecret) },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('graph_not_allowed');
  });

  test('unauthenticated graph search returns 401', async () => {
    const res = await app.request('/api/v4/graph/search?q=discussion');
    expect(res.status).toBe(401);
  });

  test('non-allowlisted npubs cannot use graph search', async () => {
    const path = '/api/v4/graph/search?q=discussion';
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', outsiderSecret) },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('graph_not_allowed');
  });

  test('an allowlisted agent can create and read only its own agent memory', async () => {
    const payload = {
      visibility: 'agent',
      actor_npub: AGENT,
      memory_type: 'preference',
      title: 'Preferred release note style',
      summary: 'Prefers concise notes with exact commands.',
      body_ciphertext: 'ciphertext-for-agent',
      entities: [
        { entity_type: 'project', entity_key: 'wingman-tower', display_name: 'Wingman Tower' },
      ],
    };

    const createRes = await app.request('/api/v4/graph/memories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/memories', 'POST', agentSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.memory.actor_npub).toBe(AGENT);
    expect(created.memory.body_ciphertext).toBe('ciphertext-for-agent');

    const ownGetPath = `/api/v4/graph/memories/${created.memory.id}`;
    const ownGet = await app.request(ownGetPath, {
      headers: { Authorization: authHeader(ownGetPath, 'GET', agentSecret) },
    });
    expect(ownGet.status).toBe(200);

    const otherGet = await app.request(ownGetPath, {
      headers: { Authorization: authHeader(ownGetPath, 'GET', otherAgentSecret) },
    });
    expect(otherGet.status).toBe(404);
  });

  test('arbitrary actor_npub impersonation is rejected without delegation', async () => {
    const payload = {
      visibility: 'agent',
      actor_npub: AGENT,
      memory_type: 'preference',
      body_ciphertext: 'ciphertext',
    };
    const res = await app.request('/api/v4/graph/memories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/memories', 'POST', otherAgentSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('graph_actor_delegation_required');
  });

  test('group memory is scoped to current group membership', async () => {
    const payload = {
      workspace_owner_npub: OWNER,
      visibility: 'group',
      group_id: groupId,
      source_app_npub: APP_NPUB,
      memory_type: 'fact',
      summary: 'The group prefers encrypted shared memories.',
      body_ciphertext: 'ciphertext-for-group',
    };
    const createRes = await app.request('/api/v4/graph/memories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/memories', 'POST', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.memory.group_id).toBe(groupId);

    const getPath = `/api/v4/graph/memories/${created.memory.id}`;
    const ownerGet = await app.request(getPath, {
      headers: { Authorization: authHeader(getPath, 'GET', ownerSecret) },
    });
    expect(ownerGet.status).toBe(200);

    const otherGet = await app.request(getPath, {
      headers: { Authorization: authHeader(getPath, 'GET', otherAgentSecret) },
    });
    expect(otherGet.status).toBe(404);
  });

  test('source_app_npub must be registered for the workspace', async () => {
    const payload = {
      workspace_owner_npub: OWNER,
      visibility: 'group',
      group_id: groupId,
      source_app_npub: AGENT,
      memory_type: 'fact',
      body_ciphertext: 'ciphertext',
    };
    const res = await app.request('/api/v4/graph/memories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/memories', 'POST', memberSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('graph_source_app_forbidden');
  });

  test('native graph import idempotently upserts nodes and edges for an agent', async () => {
    const payload = {
      visibility: 'agent',
      actor_npub: AGENT,
      run_id: 'native-graph-test-run',
      source: 'kuzu-test',
      schema: {
        schema_kind: 'property_graph',
        schema: {
          labels: ['Person', 'Project'],
          relationships: ['WORKS_ON'],
        },
      },
      nodes: [
        {
          external_id: 'person:operator',
          labels: ['Person'],
          node_type: 'Person',
          properties: { name: 'Operator', version: 1 },
        },
        {
          external_id: 'project:tower',
          labels: ['Project'],
          node_type: 'Project',
          properties: { name: 'Tower' },
        },
      ],
      edges: [
        {
          external_id: 'edge:operator:tower',
          from_external_id: 'person:operator',
          to_external_id: 'project:tower',
          relationship_type: 'WORKS_ON',
          properties: { since: '2026-05-12' },
        },
      ],
    };

    const createRes = await app.request('/api/v4/graph/import-runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/import-runs', 'POST', agentSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.import_run.nodes_upserted).toBe(2);
    expect(created.import_run.edges_upserted).toBe(1);
    expect(created.import_run.schema_upserted).toBe(1);
    expect(created.nodes).toHaveLength(2);
    expect(created.edges).toHaveLength(1);

    const updatePayload = {
      ...payload,
      nodes: [
        {
          external_id: 'person:operator',
          labels: ['Person', 'Operator'],
          node_type: 'Person',
          properties: { role: 'operator' },
        },
      ],
      edges: [],
      schema: undefined,
    };
    const updateRes = await app.request('/api/v4/graph/import-runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/import-runs', 'POST', agentSecret, updatePayload),
      },
      body: JSON.stringify(updatePayload),
    });
    expect(updateRes.status).toBe(201);

    const listPath = '/api/v4/graph/nodes?visibility=agent&actor_npub=' + encodeURIComponent(AGENT) + '&source=kuzu-test&label=Operator';
    const listRes = await app.request(listPath, {
      headers: { Authorization: authHeader(listPath, 'GET', agentSecret) },
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.total).toBe(1);
    expect(listed.nodes[0].external_id).toBe('person:operator');
    expect(listed.nodes[0].properties.name).toBe('Operator');
    expect(listed.nodes[0].properties.role).toBe('operator');

    const edgesPath = '/api/v4/graph/edges?visibility=agent&actor_npub=' + encodeURIComponent(AGENT) + '&source=kuzu-test&relationship_type=WORKS_ON';
    const edgesRes = await app.request(edgesPath, {
      headers: { Authorization: authHeader(edgesPath, 'GET', agentSecret) },
    });
    expect(edgesRes.status).toBe(200);
    const edges = await edgesRes.json();
    expect(edges.total).toBe(1);
    expect(edges.edges[0].from_external_id).toBe('person:operator');
    expect(edges.edges[0].to_external_id).toBe('project:tower');

    const neighborhoodPath = '/api/v4/graph/neighborhood?source=kuzu-test&external_id=person%3Aoperator&direction=out';
    const neighborhoodRes = await app.request(neighborhoodPath, {
      headers: { Authorization: authHeader(neighborhoodPath, 'GET', agentSecret) },
    });
    expect(neighborhoodRes.status).toBe(200);
    const neighborhood = await neighborhoodRes.json();
    expect(neighborhood.center.external_id).toBe('person:operator');
    expect(neighborhood.edges).toHaveLength(1);
    expect(neighborhood.nodes.map((node: any) => node.external_id).sort()).toEqual(['person:operator', 'project:tower']);

    const otherListRes = await app.request(listPath, {
      headers: { Authorization: authHeader(listPath, 'GET', otherAgentSecret) },
    });
    expect(otherListRes.status).toBe(200);
    const otherListed = await otherListRes.json();
    expect(otherListed.total).toBe(0);
  });

  test('agent-signed graph search finds an agent-visible node by query text', async () => {
    await importGraphFixture({
      visibility: 'agent',
      actor_npub: AGENT,
      run_id: 'graph-search-agent-fixture',
      source: 'discussion-search',
      nodes: [
        {
          external_id: 'concept:discussion-chat-response-pipeline',
          labels: ['Concept', 'Pipeline'],
          node_type: 'Concept',
          properties: {
            title: 'Discussion chat response pipeline',
            summary: 'A Flight Deck response continuity path backed by Tower graph context.',
            status: 'planned',
            large_blob: 'x'.repeat(1200),
          },
        },
      ],
      edges: [],
    });

    const path = '/api/v4/graph/search?q=response%20continuity&visibility=agent&actor_npub=' + encodeURIComponent(AGENT);
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', agentSecret) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe('response continuity');
    expect(body.results[0]).toMatchObject({
      kind: 'node',
      external_id: 'concept:discussion-chat-response-pipeline',
      source: 'discussion-search',
    });
    expect(body.results[0].properties.summary).toContain('Tower graph context');
    expect(body.results[0].properties.large_blob).toBeUndefined();
  });

  test('graph search respects source and label filters', async () => {
    await importGraphFixture({
      visibility: 'agent',
      actor_npub: AGENT,
      run_id: 'graph-search-filter-fixture',
      source: 'discussion-filter-a',
      nodes: [
        {
          external_id: 'concept:filtered-discussion-pipeline',
          labels: ['Concept', 'Pipeline'],
          node_type: 'Concept',
          properties: { title: 'Filtered discussion pipeline' },
        },
        {
          external_id: 'note:filtered-discussion-journal',
          labels: ['Note'],
          node_type: 'Note',
          properties: { title: 'Filtered discussion journal' },
        },
      ],
      edges: [],
    });
    await importGraphFixture({
      visibility: 'agent',
      actor_npub: AGENT,
      run_id: 'graph-search-filter-other-source',
      source: 'discussion-filter-b',
      nodes: [
        {
          external_id: 'concept:filtered-discussion-other-source',
          labels: ['Concept', 'Pipeline'],
          node_type: 'Concept',
          properties: { title: 'Filtered discussion other source' },
        },
      ],
      edges: [],
    });

    const path = '/api/v4/graph/search?q=filtered%20discussion&source=discussion-filter-a&label=Pipeline&visibility=agent&actor_npub=' + encodeURIComponent(AGENT);
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', agentSecret) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.results.map((result: any) => result.external_id)).toEqual(['concept:filtered-discussion-pipeline']);
  });

  test('graph search returns edges by relationship type and connected node external IDs', async () => {
    await importGraphFixture({
      visibility: 'agent',
      actor_npub: AGENT,
      run_id: 'graph-search-edge-fixture',
      source: 'discussion-edge-search',
      nodes: [
        {
          external_id: 'thread:edge-search-chat',
          labels: ['Thread'],
          node_type: 'Thread',
          properties: { title: 'Edge search chat thread' },
        },
        {
          external_id: 'concept:edge-search-continuity',
          labels: ['Concept'],
          node_type: 'Concept',
          properties: { title: 'Edge search continuity concept' },
        },
      ],
      edges: [
        {
          external_id: 'thread:edge-search-chat:mentions:concept:edge-search-continuity',
          from_external_id: 'thread:edge-search-chat',
          to_external_id: 'concept:edge-search-continuity',
          relationship_type: 'MENTIONS',
          properties: { summary: 'Thread mentions continuity concept.' },
        },
      ],
    });

    const path = '/api/v4/graph/search?q=edge-search-continuity&source=discussion-edge-search&relationship_type=MENTIONS&visibility=agent&actor_npub=' + encodeURIComponent(AGENT);
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', agentSecret) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      kind: 'edge',
      relationship_type: 'MENTIONS',
      from_external_id: 'thread:edge-search-chat',
      to_external_id: 'concept:edge-search-continuity',
    });
  });

  test('group-scoped graph search does not leak to allowlisted non-members', async () => {
    await importGraphFixture({
      visibility: 'group',
      workspace_owner_npub: OWNER,
      group_id: groupId,
      run_id: 'graph-search-group-fixture',
      source: 'discussion-group-search',
      nodes: [
        {
          external_id: 'concept:group-only-discussion-context',
          labels: ['Concept'],
          node_type: 'Concept',
          properties: { title: 'Group only discussion context' },
        },
      ],
      edges: [],
    }, memberSecret);

    const memberPath = '/api/v4/graph/search?q=group-only-discussion&visibility=group&group_id=' + encodeURIComponent(groupId);
    const memberRes = await app.request(memberPath, {
      headers: { Authorization: authHeader(memberPath, 'GET', memberSecret) },
    });
    expect(memberRes.status).toBe(200);
    const memberBody = await memberRes.json();
    expect(memberBody.total).toBe(1);

    const otherRes = await app.request(memberPath, {
      headers: { Authorization: authHeader(memberPath, 'GET', otherAgentSecret) },
    });
    expect(otherRes.status).toBe(200);
    const otherBody = await otherRes.json();
    expect(otherBody.total).toBe(0);
  });

  test('graph search rejects malformed group_id filters instead of broadening results', async () => {
    await importGraphFixture({
      visibility: 'group',
      workspace_owner_npub: OWNER,
      group_id: groupId,
      run_id: 'graph-search-invalid-group-filter-fixture',
      source: 'discussion-invalid-group-filter',
      nodes: [
        {
          external_id: 'concept:invalid-group-filter-discussion',
          labels: ['Concept'],
          node_type: 'Concept',
          properties: { title: 'Invalid group filter discussion' },
        },
      ],
      edges: [],
    }, memberSecret);

    const path = '/api/v4/graph/search?q=invalid-group-filter-discussion&visibility=group&group_id=not-a-uuid';
    const res = await app.request(path, {
      headers: { Authorization: authHeader(path, 'GET', memberSecret) },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('valid group_id required');
  });

  test('bridge neighborhood returns one bounded Story bridge and preserves scope isolation', async () => {
    await importGraphFixture({
      visibility: 'agent', actor_npub: AGENT, run_id: 'bridge-neighborhood-run', source: 'book-test',
      nodes: [
        { external_id: 'story:current', labels: ['Story'], node_type: 'Story', properties: { title: 'Current' } },
        { external_id: 'org:anthropic', labels: ['Organisation'], node_type: 'Organisation', properties: { title: 'Anthropic' } },
        { external_id: 'story:related', labels: ['Story'], node_type: 'Story', properties: { title: 'Related' } },
        { external_id: 'topic:unrelated', labels: ['Topic'], node_type: 'Topic', properties: { title: 'Unrelated' } },
      ],
      edges: [
        { external_id: 'edge:current-org', from_external_id: 'story:current', to_external_id: 'org:anthropic', relationship_type: 'MENTIONS', properties: { confidence: .9 } },
        { external_id: 'edge:related-org', from_external_id: 'story:related', to_external_id: 'org:anthropic', relationship_type: 'MENTIONS', properties: { confidence: .8 } },
      ],
    });
    const path = `/api/v4/graph/bridge-neighborhood?external_id=story%3Acurrent&relationship_types=MENTIONS&bridge_labels=Organisation&visibility=agent&actor_npub=${encodeURIComponent(AGENT)}&limit=5`;
    const res = await app.request(path, { headers: { Authorization: authHeader(path, 'GET', agentSecret) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.center.external_id).toBe('story:current');
    expect(body.bridges.map((node: any) => node.external_id)).toEqual(['org:anthropic']);
    expect(body.stories.map((node: any) => node.external_id)).toEqual(['story:related']);
    expect(body.edges).toHaveLength(2);
    const isolated = await app.request(path, { headers: { Authorization: authHeader(path, 'GET', otherAgentSecret) } });
    expect(isolated.status).toBe(404);
  });

  test('native graph edge upsert rejects missing endpoint nodes', async () => {
    const payload = {
      visibility: 'agent',
      actor_npub: AGENT,
      run_id: 'native-graph-missing-edge-run',
      source: 'kuzu-test',
      edges: [
        {
          from_external_id: 'missing:a',
          to_external_id: 'missing:b',
          relationship_type: 'KNOWS',
        },
      ],
    };
    const res = await app.request('/api/v4/graph/edges/bulk-upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader('/api/v4/graph/edges/bulk-upsert', 'POST', agentSecret, payload),
      },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('graph_edge_node_missing');
  });

  test('repository deltas create checkpoints, reconcile, replace properties, preserve other repositories, and replay idempotently', async () => {
    const base = {
      visibility: 'agent' as const,
      actor_npub: AGENT,
      source: 'code-intelligence',
      corpus_id: 'wingman-suite',
      repository_id: 'tower',
      schema_version: 'code-graph/v1',
      parser_metadata: { parser: 'tree-sitter', version: '1' },
      index_metadata: { indexed_at: '2026-08-11T00:00:00Z' },
    };
    const first = await repositoryDelta({
      ...base,
      mode: 'full_rebuild',
      head_sha: 'sha-1',
      nodes: [
        { external_id: 'wingman-suite:tower:file:a', labels: ['File'], properties: { name: 'a.ts', stale: true } },
        { external_id: 'wingman-suite:tower:symbol:gone', labels: ['Symbol'], properties: { name: 'gone' } },
      ],
      edges: [{
        external_id: 'wingman-suite:tower:edge:contains-gone',
        from_external_id: 'wingman-suite:tower:file:a',
        to_external_id: 'wingman-suite:tower:symbol:gone',
        relationship_type: 'CONTAINS',
      }],
    });
    expect(first.res.status).toBe(200);
    expect(first.body.checkpoint.head_sha).toBe('sha-1');
    expect(first.body.counts).toMatchObject({ nodes_upserted: 2, edges_upserted: 1, nodes_deleted: 0, edges_deleted: 0 });

    const unrelated = await repositoryDelta({
      ...base,
      repository_id: 'autopilot',
      mode: 'full_rebuild',
      head_sha: 'auto-1',
      nodes: [{ external_id: 'wingman-suite:autopilot:file:index', labels: ['File'], properties: { name: 'index.ts' } }],
      edges: [],
    });
    expect(unrelated.res.status).toBe(200);

    const incremental = await repositoryDelta({
      ...base,
      mode: 'incremental',
      base_sha: 'sha-1',
      head_sha: 'sha-2',
      nodes: [
        { external_id: 'wingman-suite:tower:file:a', labels: ['File'], properties: { name: 'renamed.ts' }, property_mode: 'replace' },
        { external_id: 'wingman-suite:tower:symbol:new', labels: ['Symbol'], properties: { name: 'new' } },
      ],
      edges: [{
        external_id: 'wingman-suite:tower:edge:contains-new',
        from_external_id: 'wingman-suite:tower:file:a',
        to_external_id: 'wingman-suite:tower:symbol:new',
        relationship_type: 'CONTAINS',
        properties: { line: 3 },
        property_mode: 'replace',
      }],
      delete_node_external_ids: ['wingman-suite:tower:symbol:gone'],
      delete_edge_external_ids: ['wingman-suite:tower:edge:contains-gone'],
    });
    expect(incremental.res.status).toBe(200);
    expect(incremental.body.checkpoint.head_sha).toBe('sha-2');
    expect(incremental.body.counts).toMatchObject({ nodes_upserted: 2, edges_upserted: 1, nodes_deleted: 1, edges_deleted: 1 });

    const rebuilt = await repositoryDelta({
      ...base,
      mode: 'full_rebuild',
      base_sha: 'ignored-for-full-rebuild',
      head_sha: 'sha-3',
      nodes: [{ external_id: 'wingman-suite:tower:file:a', labels: ['File'], properties: { name: 'renamed.ts' }, property_mode: 'replace' }],
      edges: [],
    });
    expect(rebuilt.res.status).toBe(200);
    expect(rebuilt.body.counts).toMatchObject({ nodes_deleted: 1, edges_deleted: 1 });

    const towerPath = '/api/v4/graph/nodes?visibility=agent&actor_npub=' + encodeURIComponent(AGENT) + '&source=code-intelligence';
    const listed = await app.request(towerPath, { headers: { Authorization: authHeader(towerPath, 'GET', agentSecret) } });
    const listedBody = await listed.json();
    const byId = new Map(listedBody.nodes.map((node: any) => [node.external_id, node]));
    expect(byId.has('wingman-suite:tower:symbol:gone')).toBe(false);
    expect(byId.has('wingman-suite:tower:symbol:new')).toBe(false);
    expect(byId.has('wingman-suite:autopilot:file:index')).toBe(true);
    expect((byId.get('wingman-suite:tower:file:a') as any).properties).toEqual({ name: 'renamed.ts' });

    const replay = await repositoryDelta({ ...base, mode: 'incremental', base_sha: 'sha-2', head_sha: 'sha-3' });
    expect(replay.res.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.counts).toEqual({ nodes_upserted: 0, edges_upserted: 0, nodes_deleted: 0, edges_deleted: 0, schema_upserted: 0 });
  });

  test('stale or invalid repository deltas do not mutate data or advance the checkpoint', async () => {
    const base = {
      visibility: 'agent' as const, actor_npub: AGENT, source: 'delta-transaction-test',
      corpus_id: 'corpus', repository_id: 'repo', schema_version: 'v1',
    };
    const first = await repositoryDelta({
      ...base, mode: 'full_rebuild', head_sha: 'head-1',
      nodes: [{ external_id: 'corpus:repo:file:a', properties: { version: 1 } }], edges: [],
    });
    expect(first.res.status).toBe(200);

    const stale = await repositoryDelta({
      ...base, mode: 'incremental', base_sha: 'wrong', head_sha: 'head-2',
      delete_node_external_ids: ['corpus:repo:file:a'],
    });
    expect(stale.res.status).toBe(409);
    expect(stale.body.code).toBe('graph_delta_stale_base');
    expect(stale.body.current_head_sha).toBe('head-1');

    const escaped = await repositoryDelta({
      ...base, mode: 'incremental', base_sha: 'head-1', head_sha: 'head-2',
      nodes: [{ external_id: 'corpus:other:file:escape' }],
    });
    expect(escaped.res.status).toBe(400);
    expect(escaped.body.code).toBe('graph_delta_scope_escape');

    const valid = await repositoryDelta({
      ...base, mode: 'incremental', base_sha: 'head-1', head_sha: 'head-2',
      nodes: [{ external_id: 'corpus:repo:file:a', properties: { version: 2 }, property_mode: 'replace' }],
    });
    expect(valid.res.status).toBe(200);
    expect(valid.body.checkpoint.head_sha).toBe('head-2');
  });

  test('repository checkpoint reads support exact and corpus lookup without leaking scope', async () => {
    const source = 'checkpoint-read-test';
    const base = { visibility: 'agent' as const, actor_npub: AGENT, source, corpus_id: 'suite', schema_version: 'code-graph/v2' };
    const tower = await repositoryDelta({
      ...base, repository_id: 'tower', mode: 'full_rebuild', head_sha: 'tower-head',
      parser_metadata: { parser: 'tree-sitter', version: '2' }, index_metadata: { files: 42 }, nodes: [], edges: [],
    });
    expect(tower.res.status).toBe(200);
    const autopilot = await repositoryDelta({
      ...base, repository_id: 'autopilot', mode: 'full_rebuild', head_sha: 'autopilot-head', nodes: [], edges: [],
    });
    expect(autopilot.res.status).toBe(200);

    const exactQuery = new URLSearchParams({
      source, visibility: 'agent', actor_npub: AGENT, corpus_id: 'suite', repository_id: 'tower', limit: '5000',
    }).toString();
    const exact = await repositoryCheckpoints(exactQuery);
    expect(exact.res.status).toBe(200);
    expect(exact.body.limit).toBe(500);
    expect(exact.body.checkpoints).toEqual([{
      source, corpus_id: 'suite', repository_id: 'tower', head_sha: 'tower-head', schema_version: 'code-graph/v2',
      parser_metadata: { parser: 'tree-sitter', version: '2' }, index_metadata: { files: 42 },
      updated_at: expect.any(String),
    }]);
    expect(exact.body.checkpoints[0].actor_npub).toBeUndefined();
    expect(exact.body.checkpoints[0].created_by_npub).toBeUndefined();

    const corpus = await repositoryCheckpoints(new URLSearchParams({ source, corpus_id: 'suite' }).toString());
    expect(corpus.res.status).toBe(200);
    expect(corpus.body.checkpoints.map((checkpoint: any) => checkpoint.repository_id).sort()).toEqual(['autopilot', 'tower']);

    const empty = await repositoryCheckpoints(new URLSearchParams({ source, corpus_id: 'missing' }).toString());
    expect(empty.res.status).toBe(200);
    expect(empty.body).toMatchObject({ checkpoints: [], count: 0 });

    const otherAgent = await repositoryCheckpoints(new URLSearchParams({ source }).toString(), otherAgentSecret);
    expect(otherAgent.res.status).toBe(200);
    expect(otherAgent.body.checkpoints).toEqual([]);

    const impersonation = await repositoryCheckpoints(new URLSearchParams({ source, actor_npub: AGENT }).toString(), otherAgentSecret);
    expect(impersonation.res.status).toBe(403);
    expect(impersonation.body.code).toBe('graph_actor_delegation_required');
  });

  test('repository checkpoint reads preserve group and workspace isolation and reject malformed filters', async () => {
    const [otherGroup] = await sql<{ id: string }[]>`
      INSERT INTO v4_groups (owner_npub, name, group_npub)
      VALUES (${OWNER}, 'Other Graph Group', 'npub1other_graph_group_test')
      RETURNING id
    `;
    await sql`INSERT INTO v4_group_members (group_id, member_npub) VALUES (${otherGroup.id}, ${OTHER_AGENT})`;
    const source = 'checkpoint-group-read-test';
    const created = await repositoryDelta({
      visibility: 'group', workspace_owner_npub: OWNER, group_id: otherGroup.id, source,
      corpus_id: 'suite', repository_id: 'private-repo', schema_version: 'v1', mode: 'full_rebuild', head_sha: 'private-head',
      nodes: [], edges: [],
    }, otherAgentSecret);
    expect(created.res.status).toBe(200);

    const memberQuery = new URLSearchParams({ source, workspace_owner_npub: OWNER, visibility: 'group', group_id: otherGroup.id }).toString();
    const isolated = await repositoryCheckpoints(memberQuery, memberSecret);
    expect(isolated.res.status).toBe(200);
    expect(isolated.body.checkpoints).toEqual([]);
    const visible = await repositoryCheckpoints(memberQuery, otherAgentSecret);
    expect(visible.res.status).toBe(200);
    expect(visible.body.checkpoints).toHaveLength(1);

    const foreignWorkspace = await repositoryCheckpoints(new URLSearchParams({
      source, workspace_owner_npub: OTHER_AGENT, visibility: 'group', group_id: otherGroup.id,
    }).toString(), memberSecret);
    expect(foreignWorkspace.res.status).toBe(403);
    expect(foreignWorkspace.body.code).toBe('graph_workspace_forbidden');

    const malformedCases = [
      '',
      'source=x&visibility=workspace',
      'source=x&group_id=not-a-uuid',
      'source=x&corpus_id=bad%3Aid',
      'source=x&repository_id=bad%3Aid',
    ];
    for (const query of malformedCases) {
      const malformed = await repositoryCheckpoints(query);
      expect(malformed.res.status).toBe(400);
    }
  });

  test('repository deltas safely create, query, reconcile, and block deletion around cross-repository edges', async () => {
    const source = 'delta-cross-repository-test';
    const common = { visibility: 'agent' as const, actor_npub: AGENT, source, corpus_id: 'corpus', schema_version: 'v1' };
    const repositoryB = await repositoryDelta({
      ...common, repository_id: 'repo-b', mode: 'full_rebuild', head_sha: 'b-1',
      nodes: [{ external_id: 'corpus:repo-b:route:get-widget', labels: ['Route'], properties: { path: '/widgets/:id' } }],
      edges: [],
    });
    expect(repositoryB.res.status).toBe(200);

    const repositoryA = await repositoryDelta({
      ...common, repository_id: 'repo-a', mode: 'full_rebuild', head_sha: 'a-1',
      nodes: [{ external_id: 'corpus:repo-a:consumer:widget-client', labels: ['Consumer'] }],
      edges: [{
        external_id: 'corpus:repo-a:edge:calls-widget',
        from_external_id: 'corpus:repo-a:consumer:widget-client',
        to_external_id: 'corpus:repo-b:route:get-widget',
        relationship_type: 'CALLS',
      }],
    });
    expect(repositoryA.res.status).toBe(200);
    expect(repositoryA.body.counts).toMatchObject({ nodes_upserted: 1, edges_upserted: 1 });

    const edgesPath = '/api/v4/graph/edges?visibility=agent&actor_npub=' + encodeURIComponent(AGENT)
      + '&source=' + encodeURIComponent(source) + '&relationship_type=CALLS';
    const listed = await app.request(edgesPath, { headers: { Authorization: authHeader(edgesPath, 'GET', agentSecret) } });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.edges).toEqual(expect.arrayContaining([expect.objectContaining({
      external_id: 'corpus:repo-a:edge:calls-widget',
      from_external_id: 'corpus:repo-a:consumer:widget-client',
      to_external_id: 'corpus:repo-b:route:get-widget',
    })]));

    const blockedB = await repositoryDelta({
      ...common, repository_id: 'repo-b', mode: 'full_rebuild', head_sha: 'b-2', nodes: [], edges: [],
    });
    expect(blockedB.res.status).toBe(409);
    expect(blockedB.body.code).toBe('graph_delta_cross_repository_edge');

    const removedA = await repositoryDelta({
      ...common, repository_id: 'repo-a', mode: 'full_rebuild', head_sha: 'a-2',
      nodes: [{ external_id: 'corpus:repo-a:consumer:widget-client', labels: ['Consumer'] }], edges: [],
    });
    expect(removedA.res.status).toBe(200);
    expect(removedA.body.counts).toMatchObject({ nodes_deleted: 0, edges_deleted: 1 });

    const nodesPath = '/api/v4/graph/nodes?visibility=agent&actor_npub=' + encodeURIComponent(AGENT) + '&source=' + encodeURIComponent(source);
    const afterA = await app.request(nodesPath, { headers: { Authorization: authHeader(nodesPath, 'GET', agentSecret) } });
    const afterABody = await afterA.json();
    expect(afterABody.nodes.map((node: any) => node.external_id)).toContain('corpus:repo-b:route:get-widget');

    const deletedB = await repositoryDelta({
      ...common, repository_id: 'repo-b', mode: 'full_rebuild', head_sha: 'b-2', nodes: [], edges: [],
    });
    expect(deletedB.res.status).toBe(200);
    expect(deletedB.body.counts.nodes_deleted).toBe(1);

    const impersonation = await repositoryDelta({
      ...common, repository_id: 'repo-a', mode: 'incremental', base_sha: 'a-2', head_sha: 'a-3', nodes: [], edges: [],
    }, otherAgentSecret);
    expect(impersonation.res.status).toBe(403);
    expect(impersonation.body.code).toBe('graph_actor_delegation_required');
  });

  test('repository delta cross-repository endpoints stay within corpus, source, and security scope', async () => {
    const edge = (to_external_id: string) => ({
      external_id: 'corpus:repo-a:edge:test',
      from_external_id: 'corpus:repo-a:consumer:test',
      to_external_id,
      relationship_type: 'CALLS',
    });
    const attempt = (source: string, head_sha: string, to_external_id: string) => repositoryDelta({
      visibility: 'agent', actor_npub: AGENT, source, corpus_id: 'corpus', repository_id: 'repo-a',
      schema_version: 'v1', mode: 'full_rebuild', head_sha,
      nodes: [{ external_id: 'corpus:repo-a:consumer:test' }], edges: [edge(to_external_id)],
    });

    const crossCorpus = await attempt('delta-endpoint-cross-corpus', 'a-1', 'other:repo-b:route:test');
    expect(crossCorpus.res.status).toBe(400);
    expect(crossCorpus.body.code).toBe('graph_delta_scope_escape');

    const missing = await attempt('delta-endpoint-missing', 'a-1', 'corpus:repo-b:route:missing');
    expect(missing.res.status).toBe(400);
    expect(missing.body.code).toBe('graph_edge_node_missing');

    const foreignSourceNode = await repositoryDelta({
      visibility: 'agent', actor_npub: AGENT, source: 'delta-endpoint-foreign-source', corpus_id: 'corpus', repository_id: 'repo-b',
      schema_version: 'v1', mode: 'full_rebuild', head_sha: 'b-1', nodes: [{ external_id: 'corpus:repo-b:route:test' }], edges: [],
    });
    expect(foreignSourceNode.res.status).toBe(200);
    const foreignSource = await attempt('delta-endpoint-local-source', 'a-1', 'corpus:repo-b:route:test');
    expect(foreignSource.res.status).toBe(400);
    expect(foreignSource.body.code).toBe('graph_edge_node_missing');

    const inaccessibleNode = await repositoryDelta({
      visibility: 'agent', actor_npub: OTHER_AGENT, source: 'delta-endpoint-security', corpus_id: 'corpus', repository_id: 'repo-b',
      schema_version: 'v1', mode: 'full_rebuild', head_sha: 'b-1', nodes: [{ external_id: 'corpus:repo-b:route:test' }], edges: [],
    }, otherAgentSecret);
    expect(inaccessibleNode.res.status).toBe(200);
    const inaccessible = await attempt('delta-endpoint-security', 'a-1', 'corpus:repo-b:route:test');
    expect(inaccessible.res.status).toBe(400);
    expect(inaccessible.body.code).toBe('graph_edge_node_missing');
  });
});
