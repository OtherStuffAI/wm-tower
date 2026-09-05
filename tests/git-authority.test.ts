import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { closeDb, setDb } from '../src/db';
import { splitSqlStatements } from '../src/schema/sql-statements';
import { ensureRuntimeSchema } from '../src/schema/ensure-runtime-schema';
import { createApp } from '../src/server';
import { config } from '../src/config';

const TEST_DB = process.env.TEST_DB_NAME || 'coworker_v4_test_git_authority';
const GIT_AUDIENCE = config.git.audience;
const INTERNAL_TOKEN = config.git.internalServiceToken;

const ownerSecret = new Uint8Array(32).fill(91);
const readerSecret = new Uint8Array(32).fill(92);
const contributorSecret = new Uint8Array(32).fill(93);
const foreignSecret = new Uint8Array(32).fill(94);
const sessionKeySecret = new Uint8Array(32).fill(95);
const spareSecret = new Uint8Array(32).fill(96);

const OWNER_NPUB = nip19.npubEncode(getPublicKey(ownerSecret));
const READER_NPUB = nip19.npubEncode(getPublicKey(readerSecret));
const CONTRIBUTOR_NPUB = nip19.npubEncode(getPublicKey(contributorSecret));
const FOREIGN_NPUB = nip19.npubEncode(getPublicKey(foreignSecret));
const SESSION_KEY_NPUB = nip19.npubEncode(getPublicKey(sessionKeySecret));
const SPARE_NPUB = nip19.npubEncode(getPublicKey(spareSecret));

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;
let workspaceId: string;
let foreignWorkspaceId: string;
let ownerId: string;
let readerId: string;
let contributorId: string;
let foreignId: string;
let spareId: string;
let contributorGroupId: string;
let repositoryId: string;
let secondRepositoryId: string;

function sha256Hex(input: string) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function authHeader(input: {
  path: string;
  method: string;
  secret: Uint8Array;
  rawBody?: string;
  signedPath?: string;
  signedMethod?: string;
  payloadHash?: string | null;
  createdAt?: number;
}) {
  const tags: string[][] = [
    ['u', `http://localhost${input.signedPath ?? input.path}`],
    ['method', input.signedMethod ?? input.method.toUpperCase()],
    ['nonce', randomUUID()],
  ];
  if (input.payloadHash !== null && input.rawBody !== undefined) {
    tags.push(['payload', input.payloadHash ?? sha256Hex(input.rawBody)]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, input.secret);
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

async function publicRequest(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  secret: Uint8Array,
  body?: unknown,
  signed?: { path?: string; method?: string; payloadHash?: string | null; createdAt?: number },
) {
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const response = await app.request(path, {
    method,
    headers: {
      Authorization: authHeader({
        path,
        method,
        secret,
        rawBody,
        signedPath: signed?.path,
        signedMethod: signed?.method,
        payloadHash: signed?.payloadHash,
        createdAt: signed?.createdAt,
      }),
      ...(rawBody === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: rawBody,
  });
  return { response, json: await response.json() as any };
}

async function exchangeRequest(
  body: Record<string, unknown>,
  secret: Uint8Array,
  options: { path?: string; signedPath?: string; signedMethod?: string; payloadHash?: string | null; createdAt?: number; authorization?: string } = {},
) {
  const path = options.path ?? '/api/v4/git/credential-exchanges';
  const rawBody = JSON.stringify(body);
  const authorization = options.authorization ?? authHeader({
    path,
    method: 'POST',
    secret,
    rawBody,
    signedPath: options.signedPath,
    signedMethod: options.signedMethod,
    payloadHash: options.payloadHash,
    createdAt: options.createdAt,
  });
  const response = await app.request(path, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: rawBody,
  });
  return { response, json: await response.json() as any, authorization };
}

async function issueMutationRequest(
  path: string,
  body: Record<string, unknown>,
  secret: Uint8Array,
  authorization?: string,
) {
  const rawBody = JSON.stringify(body);
  const signedAuthorization = authorization ?? authHeader({ path, method: 'POST', secret, rawBody });
  const response = await app.request(path, {
    method: 'POST',
    headers: { authorization: signedAuthorization, 'content-type': 'application/json' },
    body: rawBody,
  });
  return { response, json: await response.json() as any, authorization: signedAuthorization };
}

async function internalRequest(path: string, body: unknown, token = INTERNAL_TOKEN) {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wingman-git-service-token': token },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json() as any };
}

async function createDatabase() {
  const adminOptions: any = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
  };
  if (process.env.DB_USER) adminOptions.username = process.env.DB_USER;
  if (process.env.DB_PASSWORD) adminOptions.password = process.env.DB_PASSWORD;
  const admin = postgres(adminOptions);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB.replace(/"/g, '""')}"`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
  const testOptions: any = { ...adminOptions, database: TEST_DB };
  sql = postgres(testOptions);
  setDb(sql);
  const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/schema/001_init.sql'), 'utf8');
  for (const statement of splitSqlStatements(migration)) await sql.unsafe(statement);
  await ensureRuntimeSchema(sql as any);
}

async function seedActorsAndWorkspaces() {
  const actors = await sql<{ id: string; npub: string }[]>`
    INSERT INTO flightdeck_pg_actors (npub, kind, display_name)
    VALUES
      (${OWNER_NPUB}, 'human', 'Git Owner'),
      (${READER_NPUB}, 'human', 'Git Reader'),
      (${CONTRIBUTOR_NPUB}, 'agent', 'Git Agent'),
      (${FOREIGN_NPUB}, 'human', 'Foreign Actor'),
      (${SPARE_NPUB}, 'human', 'Spare Actor')
    RETURNING id, npub
  `;
  const ids = new Map(actors.map((actor) => [actor.npub, actor.id]));
  ownerId = ids.get(OWNER_NPUB)!;
  readerId = ids.get(READER_NPUB)!;
  contributorId = ids.get(CONTRIBUTOR_NPUB)!;
  foreignId = ids.get(FOREIGN_NPUB)!;
  spareId = ids.get(SPARE_NPUB)!;
  const [workspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub, workspace_service_npub, workspace_owner_npub,
      app_npub, name, slug, created_by_actor_id
    ) VALUES ('npub1towergitauthority', 'npub1workspacegitauthority', ${OWNER_NPUB},
              'npub1flightdeckgitauthority', 'Git Authority', 'git-authority', ${ownerId})
    RETURNING id
  `;
  workspaceId = workspace.id;
  const [foreignWorkspace] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_workspaces (
      tower_service_npub, workspace_service_npub, workspace_owner_npub,
      app_npub, name, slug, created_by_actor_id
    ) VALUES ('npub1towergitauthority', 'npub1foreignworkspacegit', ${FOREIGN_NPUB},
              'npub1flightdeckgitauthority', 'Foreign Workspace', 'foreign-git', ${foreignId})
    RETURNING id
  `;
  foreignWorkspaceId = foreignWorkspace.id;
  await sql`
    INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id)
    VALUES
      (${workspaceId}, ${ownerId}, 'owner', ${ownerId}),
      (${workspaceId}, ${readerId}, 'member', ${ownerId}),
      (${workspaceId}, ${contributorId}, 'agent', ${ownerId}),
      (${workspaceId}, ${spareId}, 'member', ${ownerId}),
      (${foreignWorkspaceId}, ${foreignId}, 'owner', ${foreignId})
  `;
  const [contributorGroup] = await sql<{ id: string }[]>`
    INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id)
    VALUES (${workspaceId}, 'Git Contributors', 'custom', ${ownerId})
    RETURNING id
  `;
  contributorGroupId = contributorGroup.id;
  await sql`
    INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
    VALUES (${workspaceId}, ${contributorGroupId}, ${contributorId}, ${ownerId})
  `;
  await sql`
    INSERT INTO user_profiles (user_npub, display_name)
    VALUES (${OWNER_NPUB}, 'Git Owner')
    ON CONFLICT (user_npub) DO NOTHING
  `;
  await sql`
    INSERT INTO user_workspace_keys (
      workspace_owner_npub, user_npub, ws_key_npub, active
    ) VALUES ('npub1workspacegitauthority', ${OWNER_NPUB}, ${SESSION_KEY_NPUB}, true)
  `;
}

beforeAll(async () => {
  if (!GIT_AUDIENCE || !INTERNAL_TOKEN || !config.git.capabilityHashKey) {
    throw new Error('Git authority tests require GIT_SERVICE_AUDIENCE, GIT_INTERNAL_SERVICE_TOKEN, and GIT_CAPABILITY_HASH_KEY');
  }
  await createDatabase();
  await seedActorsAndWorkspaces();
  app = createApp();
});

afterAll(async () => {
  await closeDb();
});

describe('Tower Git authority v1', () => {
  test('owner registers a private repository with non-writable protected refs and explicit actor/group grants', async () => {
    const initialActorUsername = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/actor-username`, 'GET', ownerSecret);
    expect(initialActorUsername.response.status).toBe(200);
    expect(initialActorUsername.json.actor_username).toMatchObject({ actor_id: ownerId, state: 'pending' });
    expect(initialActorUsername.json.actor_username.username).toMatch(/^wm-[a-f0-9]{32}$/);
    const invalidActorUsername = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/actor-username`, 'PUT', ownerSecret, { username: `wm-${'b'.repeat(32)}` });
    expect(invalidActorUsername.response.status).toBe(400);
    expect(invalidActorUsername.json.code).toBe('git_actor_username_invalid');
    const requestedActorUsername = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/actor-username`, 'PUT', ownerSecret, { username: 'git-owner' });
    expect(requestedActorUsername.response.status).toBe(202);
    expect(requestedActorUsername.json.actor_username).toMatchObject({ username: 'git-owner', state: 'pending' });
    expect(requestedActorUsername.json.actor_username.applied_username).toMatch(/^wm-[a-f0-9]{32}$/);
    const pendingActorUsernames = await app.request('/api/v4/git/internal/forgejo/actor-usernames/pending', {
      headers: { 'x-wingman-git-service-token': INTERNAL_TOKEN },
    });
    expect(pendingActorUsernames.status).toBe(200);
    expect((await pendingActorUsernames.json() as any).actor_usernames).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor_id: ownerId, desired_username: 'git-owner' }),
    ]));
    const actorUsernameAck = await app.request(`/api/v4/git/internal/forgejo/actor-usernames/${ownerId}/ack`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wingman-git-service-token': INTERNAL_TOKEN },
      body: JSON.stringify({ desired_username: 'git-owner', ok: true }),
    });
    expect(actorUsernameAck.status).toBe(200);
    expect((await actorUsernameAck.json() as any).actor_username).toMatchObject({ username: 'git-owner', applied_username: 'git-owner', state: 'pending' });
    const invalidNamespace = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/namespace`, 'PUT', ownerSecret, { namespace: 'assets' });
    expect(invalidNamespace.response.status).toBe(400);
    expect(invalidNamespace.json.code).toBe('git_namespace_invalid');
    const legacyNamespace = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/namespace`, 'PUT', ownerSecret, { namespace: `wm-${'a'.repeat(32)}` });
    expect(legacyNamespace.response.status).toBe(400);
    expect(legacyNamespace.json.code).toBe('git_namespace_invalid');
    const claimedNamespace = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/namespace`, 'PUT', ownerSecret, { namespace: 'wm-git-authority' });
    expect(claimedNamespace.response.status).toBe(200);
    expect(claimedNamespace.json.namespace).toMatchObject({ namespace: 'wm-git-authority', locked: false });
    const created = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories`, 'POST', ownerSecret, {
      slug: 'private-control-plane',
      display_name: 'Private Control Plane',
      description: 'Tower authority acceptance repository',
    });
    expect(created.response.status).toBe(201);
    repositoryId = created.json.repository.repository_id;
    expect(created.json.repository.visibility).toBe('private');
    expect(created.json.repository).toMatchObject({
      git_namespace: 'wm-git-authority',
      git_path: 'wm-git-authority/private-control-plane',
    });
    const lockedNamespace = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/namespace`, 'PUT', ownerSecret, { namespace: 'renamed-git-authority' });
    expect(lockedNamespace.response.status).toBe(409);
    expect(lockedNamespace.json.code).toBe('git_namespace_locked');

    const second = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories`, 'POST', ownerSecret, {
      slug: 'second-private-repo',
      display_name: 'Second Private Repo',
    });
    expect(second.response.status).toBe(201);
    secondRepositoryId = second.json.repository.repository_id;

    const policy = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/policy`, 'GET', ownerSecret);
    expect(policy.response.status).toBe(200);
    for (const refName of ['refs/heads/main', 'refs/heads/staging', 'refs/heads/deployed']) {
      const rule = policy.json.policy.branch_rules.find((item: any) => item.ref_name === refName);
      expect(rule).toMatchObject({
        protected: true,
        service_managed: true,
        allow_direct_push: false,
        allow_force_push: false,
        allow_delete: false,
      });
    }
    const weakenedRules = policy.json.policy.branch_rules.map((rule: any) => ({ ...rule, ...(rule.ref_name === 'refs/heads/main' ? { allow_direct_push: true } : {}) }));
    const weakened = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/policy`, 'PATCH', ownerSecret, {
      expected_policy_revision: policy.json.policy.policy_revision,
      branch_rules: weakenedRules,
    });
    expect(weakened.response.status).toBe(400);
    expect(weakened.json.code).toBe('git_protected_ref_not_writable');

    const grantsPath = `/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/grants`;
    for (const grant of [
      { principal_type: 'actor', principal_id: readerId, permission: 'git.repo.read' },
      { principal_type: 'group', principal_id: contributorGroupId, permission: 'git.repo.write' },
      { principal_type: 'group', principal_id: contributorGroupId, permission: 'git.branch.create' },
      { principal_type: 'actor', principal_id: ownerId, permission: 'git.repo.read' },
    ]) {
      const result = await publicRequest(grantsPath, 'POST', ownerSecret, grant);
      expect(result.response.status).toBe(201);
    }
    const grants = await publicRequest(grantsPath, 'GET', ownerSecret);
    expect(grants.response.status).toBe(200);
    expect(grants.json.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ principal_type: 'actor', principal_actor_id: readerId, permission: 'git.repo.read' }),
      expect.objectContaining({ principal_type: 'group', principal_group_id: contributorGroupId, permission: 'git.repo.write' }),
    ]));
    const resolvePath = `/api/v4/git/workspaces/${workspaceId}/repositories/resolve?path=${encodeURIComponent('/wm-git-authority/private-control-plane.git')}`;
    const resolved = await publicRequest(resolvePath, 'GET', readerSecret);
    expect(resolved.response.status).toBe(200);
    expect(resolved.json).toMatchObject({
      canonical_path: '/wm-git-authority/private-control-plane.git',
      repository: { repository_id: repositoryId, workspace_id: workspaceId },
    });
    const malformed = await publicRequest(
      `/api/v4/git/workspaces/${workspaceId}/repositories/resolve?path=${encodeURIComponent('/wm-git-authority/private-control-plane')}`,
      'GET', readerSecret,
    );
    expect(malformed.response.status).toBe(404);
  });

  test('Forgejo desired state expands actor and group grants on PostgreSQL', async () => {
    const response = await app.request(`/api/v4/git/internal/forgejo/repositories/${repositoryId}/desired-state`, {
      headers: { 'x-wingman-git-service-token': INTERNAL_TOKEN },
    });
    expect(response.status).toBe(200);
    const desired = await response.json() as any;
    expect(desired).toMatchObject({
      repository_id: repositoryId,
      forgejo_owner: 'wm-git-authority',
      forgejo_repository: 'private-control-plane',
      private: true,
    });
    expect(desired.actor_access).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor_id: ownerId, shadow_username: 'git-owner', display_name: 'Git Owner', permission: 'admin', organization_role: 'owner' }),
      expect.objectContaining({ actor_id: readerId, display_name: 'Git Reader', permission: 'read', organization_role: 'member' }),
      expect.objectContaining({ actor_id: contributorId, display_name: 'Git Agent', permission: 'write', organization_role: 'member' }),
    ]));
  });

  test('workspace Git namespaces and pending Forgejo organizations exist before repository creation', async () => {
    const bindings = await sql<any[]>`
      SELECT namespace.workspace_id, namespace.namespace, binding.forgejo_owner, binding.state
      FROM git_workspace_namespaces namespace
      JOIN git_forgejo_workspace_bindings binding ON binding.workspace_id = namespace.workspace_id
      WHERE namespace.workspace_id IN (${workspaceId}, ${foreignWorkspaceId})
      ORDER BY namespace.workspace_id
    `;
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((row) => row.namespace)).size).toBe(2);
    expect(bindings.every((row) => row.namespace === row.forgejo_owner && row.state === 'pending')).toBeTrue();

    const pending = await app.request('/api/v4/git/internal/forgejo/organizations/pending', {
      headers: { 'x-wingman-git-service-token': INTERNAL_TOKEN },
    });
    expect(pending.status).toBe(200);
    expect((await pending.json() as any).organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: workspaceId, forgejo_owner: 'wm-git-authority' }),
      expect.objectContaining({ workspace_id: foreignWorkspaceId, forgejo_owner: 'foreign-git' }),
    ]));
  });

  test('browser actor validation resolves workspace keys and group changes fail closed until exact reconciliation', async () => {
    await sql`
      UPDATE git_forgejo_repository_bindings binding
      SET state = 'ready', applied_policy_revision = repository.policy_revision,
          desired_policy_revision = repository.policy_revision, reconciled_at = NOW()
      FROM git_repositories repository
      WHERE binding.repository_id = repository.id
    `;
    await sql`UPDATE git_repositories SET state = 'active' WHERE id IN (${repositoryId}, ${secondRepositoryId})`;
    await sql`
      UPDATE git_forgejo_workspace_bindings
      SET state = 'ready', reconciled_at = NOW(), updated_at = NOW()
      WHERE workspace_id IN (${workspaceId}, ${foreignWorkspaceId})
    `;
    const reader = await internalRequest('/api/v4/git/internal/forgejo/browser/validate', { signer_npub: READER_NPUB });
    expect(reader.response.status).toBe(200);
    expect(reader.json).toMatchObject({ active: true, actor_id: readerId, actor_display_name: 'Git Reader', signer_npub: READER_NPUB });
    expect(reader.json.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository_id: repositoryId, permission: 'read' }),
    ]));
    expect(reader.json.organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ workspace_id: workspaceId, forgejo_owner: 'wm-git-authority', organization_role: 'member' }),
    ]));
    const workspaceKey = await internalRequest('/api/v4/git/internal/forgejo/browser/validate', { signer_npub: SESSION_KEY_NPUB });
    expect(workspaceKey.json).toMatchObject({ active: true, actor_id: ownerId, actor_npub: OWNER_NPUB, signer_npub: SESSION_KEY_NPUB });
    const unknown = await internalRequest('/api/v4/git/internal/forgejo/browser/validate', { signer_npub: nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(97))) });
    expect(unknown.json).toEqual({ active: false, reason_code: 'git_browser_actor_unknown' });

    const [before] = await sql<any[]>`SELECT policy_revision FROM git_repositories WHERE id = ${repositoryId}`;
    await sql`
      DELETE FROM flightdeck_pg_group_memberships
      WHERE workspace_id = ${workspaceId} AND group_id = ${contributorGroupId} AND actor_id = ${contributorId}
    `;
    const [staleBinding] = await sql<any[]>`
      SELECT repository.policy_revision, binding.desired_policy_revision, binding.state
      FROM git_repositories repository JOIN git_forgejo_repository_bindings binding ON binding.repository_id = repository.id
      WHERE repository.id = ${repositoryId}
    `;
    expect(staleBinding.policy_revision).toBe(Number(before.policy_revision) + 1);
    expect(staleBinding).toMatchObject({ desired_policy_revision: staleBinding.policy_revision, state: 'pending' });
    const stale = await internalRequest('/api/v4/git/internal/forgejo/browser/validate', { signer_npub: READER_NPUB, expected_actor_id: readerId });
    expect(stale.json).toEqual({ active: false, reason_code: 'git_browser_reconciliation_stale' });

    await sql`
      INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id)
      VALUES (${workspaceId}, ${contributorGroupId}, ${contributorId}, ${ownerId})
    `;
    await sql`
      UPDATE git_forgejo_repository_bindings binding
      SET state = 'ready', applied_policy_revision = repository.policy_revision,
          desired_policy_revision = repository.policy_revision, reconciled_at = NOW()
      FROM git_repositories repository
      WHERE binding.repository_id = repository.id
    `;
  });

  test('NIP-98 actors read, create, and comment on issues through the isolated broker', async () => {
    const originalFetch = globalThis.fetch;
    const originalBrokerUrl = config.git.issueBrokerUrl;
    const originalBrokerToken = config.git.issueBrokerToken;
    const brokerToken = 'tower-issue-broker-test-token-00000000';
    const calls: Array<{ operation: string; body: any; token: string | null }> = [];
    config.git.issueBrokerUrl = 'http://issue-broker.test';
    config.git.issueBrokerToken = brokerToken;
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const operation = String(input).split('/').pop() || '';
      const requestBody = JSON.parse(String(init.body || '{}'));
      calls.push({ operation, body: requestBody, token: new Headers(init.headers).get('x-wingman-issue-broker-token') });
      const issue = {
        issue_number: 1, title: requestBody.title || 'Existing issue', body: requestBody.body || 'Body',
        state: 'open', url: 'https://forgejo.example/wm-git-authority/private-control-plane/issues/1',
        author: { username: requestBody.actor_username, display_name: requestBody.actor_display_name },
        labels: [], comment_count: operation === 'comment' ? 1 : 0,
        created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', closed_at: null,
      };
      if (operation === 'list') return Response.json({ issues: [issue] });
      if (operation === 'comment') {
        return Response.json({ comment: {
          comment_id: 10, issue_number: 1, body: requestBody.body,
          url: `${issue.url}#issuecomment-10`, author: issue.author,
          created_at: issue.created_at, updated_at: issue.updated_at,
        } }, { status: 201 });
      }
      return Response.json({ issue }, { status: operation === 'create' ? 201 : 200 });
    }) as typeof fetch;

    try {
      const base = `/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/issues`;
      const listed = await publicRequest(`${base}?state=all&page=1&limit=25`, 'GET', readerSecret);
      expect(listed.response.status).toBe(200);
      expect(listed.json.issues).toHaveLength(1);
      expect(calls.at(-1)).toMatchObject({
        operation: 'list', token: brokerToken,
        body: { actor_display_name: 'Git Reader', state: 'all', page: 1, limit: 25 },
      });

      const createBody = { title: 'Add offline Amber signing', body: 'Support NIP-55.', correlation_id: 'issue-create-test' };
      const created = await issueMutationRequest(base, createBody, ownerSecret);
      expect(created.response.status).toBe(201);
      expect(created.json.issue).toMatchObject({ issue_number: 1, author: { username: 'git-owner' } });
      expect(calls.at(-1)).toMatchObject({ operation: 'create', body: { actor_username: 'git-owner' } });
      const callsAfterCreate = calls.length;
      const replay = await issueMutationRequest(base, createBody, ownerSecret, created.authorization);
      expect(replay.response.status).toBe(200);
      expect(replay.json).toEqual(created.json);
      expect(calls).toHaveLength(callsAfterCreate);

      const denied = await issueMutationRequest(base, { title: 'Reader cannot create' }, readerSecret);
      expect(denied.response.status).toBe(403);
      expect(denied.json.code).toBe('git_issue_write_denied');
      expect(calls).toHaveLength(callsAfterCreate);

      const commented = await issueMutationRequest(`${base}/1/comments`, {
        body: 'Signed Tower comment', correlation_id: 'issue-comment-test',
      }, ownerSecret);
      expect(commented.response.status).toBe(201);
      expect(commented.json.comment).toMatchObject({ comment_id: 10, issue_number: 1, body: 'Signed Tower comment' });

      const [mutation] = await sql<any[]>`
        SELECT decision, result FROM git_nip98_mutation_events
        WHERE event_id = ${JSON.parse(Buffer.from(created.authorization.slice(6), 'base64').toString('utf8')).id}
      `;
      expect(mutation).toMatchObject({ decision: 'allow', result: created.json });
      const [audit] = await sql<any[]>`
        SELECT actor_id, actor_npub, signer_npub, requested_scope, decision, reason_code
        FROM git_audit_events
        WHERE repository_id = ${repositoryId} AND correlation_id = 'issue-create-test'
      `;
      expect(audit).toMatchObject({
        actor_id: ownerId, actor_npub: OWNER_NPUB, signer_npub: OWNER_NPUB,
        requested_scope: 'git.issue.write', decision: 'allow', reason_code: 'git_issue_created',
      });
    } finally {
      globalThis.fetch = originalFetch;
      config.git.issueBrokerUrl = originalBrokerUrl;
      config.git.issueBrokerToken = originalBrokerToken;
    }
  });

  test('foreign and ungranted actors receive non-disclosing repository results', async () => {
    const read = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}`, 'GET', foreignSecret);
    expect(read.response.status).toBe(404);
    expect(read.json.code).toBe('git_repository_not_found');
    const unknown = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/00000000-0000-4000-8000-000000000000`, 'GET', foreignSecret);
    expect(unknown.response.status).toBe(404);
    expect(unknown.json).toEqual(read.json);
    const list = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories`, 'GET', foreignSecret);
    expect(list.response.status).toBe(200);
    expect(list.json.repositories).toEqual([]);
    expect(foreignWorkspaceId).not.toBe(workspaceId);
    const resolved = await publicRequest(
      `/api/v4/git/workspaces/${workspaceId}/repositories/resolve?path=${encodeURIComponent('/wm-git-authority/private-control-plane.git')}`,
      'GET', foreignSecret,
    );
    expect(resolved.response.status).toBe(404);
    expect(resolved.json.code).toBe('git_repository_not_found');
  });

  test('strict NIP-98 exchange rejects method, exact URL/query, payload, stale events, actor mismatch, and replay', async () => {
    const body = {
      repository_id: repositoryId,
      actor_id: readerId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      requested_scopes: ['git.fetch'],
      session_id: 'strict-tests',
    };
    const wrongMethod = await exchangeRequest(body, readerSecret, { signedMethod: 'GET' });
    expect(wrongMethod.response.status).toBe(401);
    expect(wrongMethod.json.code).toBe('nip98_method_mismatch');
    const queryPath = '/api/v4/git/credential-exchanges?purpose=clone&attempt=1';
    const wrongQuery = await exchangeRequest(body, readerSecret, { path: queryPath, signedPath: '/api/v4/git/credential-exchanges?purpose=clone&attempt=2' });
    expect(wrongQuery.response.status).toBe(401);
    expect(wrongQuery.json.code).toBe('nip98_url_mismatch');
    const wrongPayload = await exchangeRequest(body, readerSecret, { payloadHash: '0'.repeat(64) });
    expect(wrongPayload.response.status).toBe(401);
    expect(wrongPayload.json.code).toBe('nip98_payload_mismatch');
    const missingPayload = await exchangeRequest(body, readerSecret, { payloadHash: null });
    expect(missingPayload.response.status).toBe(401);
    expect(missingPayload.json.code).toBe('nip98_payload_required');
    const stale = await exchangeRequest(body, readerSecret, { createdAt: Math.floor(Date.now() / 1000) - 61 });
    expect(stale.response.status).toBe(401);
    expect(stale.json.code).toBe('nip98_stale_event');
    const actorMismatch = await exchangeRequest({ ...body, actor_id: contributorId }, readerSecret);
    expect(actorMismatch.response.status).toBe(403);
    expect(actorMismatch.json.code).toBe('git_actor_mismatch');
    const foreign = await exchangeRequest({ ...body, actor_id: foreignId }, foreignSecret);
    expect(foreign.response.status).toBe(404);
    expect(foreign.json.code).toBe('git_repository_not_found');
    const foreignContext = await exchangeRequest({
      ...body,
      task_id: '00000000-0000-4000-8000-000000000001',
      correlation_id: 'foreign-context-test',
    }, readerSecret);
    expect(foreignContext.response.status).toBe(404);
    expect(foreignContext.json.code).toBe('git_context_not_found');

    const rawBody = JSON.stringify(body);
    const authorization = authHeader({ path: '/api/v4/git/credential-exchanges', method: 'POST', secret: readerSecret, rawBody });
    const valid = await exchangeRequest(body, readerSecret, { authorization });
    expect(valid.response.status).toBe(201);
    const replay = await exchangeRequest(body, readerSecret, { authorization });
    expect(replay.response.status).toBe(409);
    expect(replay.json.code).toBe('git_exchange_replayed_event');
  });

  test('current exchange resolves the actor and derives every transport scope from live grants', async () => {
    const derived = await exchangeRequest({
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      session_id: 'service-neutral-session',
    }, contributorSecret);
    expect(derived.response.status).toBe(201);
    expect(derived.json).toMatchObject({
      actor_id: contributorId,
      signer_npub: CONTRIBUTOR_NPUB,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: null,
      scopes: ['git.fetch', 'git.push.branch_create', 'git.push.unprotected'],
    });

    const fetchDecision = await internalRequest('/api/v4/git/internal/capabilities/introspect', {
      capability: derived.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      required_scope: 'git.fetch',
    });
    expect(fetchDecision.json).toMatchObject({ active: true, service: 'upload-pack' });
    const pushDecision = await internalRequest('/api/v4/git/internal/capabilities/introspect', {
      capability: derived.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'receive-pack',
      required_scope: 'git.push.unprotected',
    });
    expect(pushDecision.json).toMatchObject({
      active: true,
      service: 'receive-pack',
      ref_constraints: { prefixes: ['refs/heads/feature/', 'refs/heads/work/'] },
    });
    await sql`
      UPDATE git_capabilities
      SET ref_constraints = ${sql.json({ prefixes: ['refs/heads/foreign/'] })}
      WHERE id = ${derived.json.capability_id}
    `;
    const staleConstraints = await internalRequest('/api/v4/git/internal/capabilities/introspect', {
      capability: derived.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'receive-pack',
      required_scope: 'git.push.unprotected',
    });
    expect(staleConstraints.json).toEqual({ active: false, reason_code: 'git_capability_ref_constraints_stale' });

    const partialLegacy = await exchangeRequest({
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      actor_id: contributorId,
    }, contributorSecret);
    expect(partialLegacy.response.status).toBe(400);
    expect(partialLegacy.json.code).toBe('git_legacy_request_invalid');
    const excessiveLegacy = await exchangeRequest({
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      actor_id: readerId,
      service: 'receive-pack',
      requested_scopes: ['git.push.unprotected'],
    }, readerSecret);
    expect(excessiveLegacy.response.status).toBe(403);
    expect(excessiveLegacy.json.code).toBe('git_scope_not_granted');
  });

  test('introspection rejects a capability after its workspace signer is revoked', async () => {
    const issued = await exchangeRequest({
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
    }, sessionKeySecret);
    expect(issued.response.status).toBe(201);
    expect(issued.json.signer_npub).toBe(SESSION_KEY_NPUB);

    await sql`
      UPDATE user_workspace_keys
      SET active = false, revoked_at = NOW()
      WHERE workspace_owner_npub = 'npub1workspacegitauthority'
        AND ws_key_npub = ${SESSION_KEY_NPUB}
    `;
    const revokedSigner = await internalRequest('/api/v4/git/internal/capabilities/introspect', {
      capability: issued.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      required_scope: 'git.fetch',
    });
    expect(revokedSigner.json).toEqual({ active: false, reason_code: 'git_capability_signer_inactive' });

    await sql`
      UPDATE user_workspace_keys
      SET active = true, revoked_at = NULL
      WHERE workspace_owner_npub = 'npub1workspacegitauthority'
        AND ws_key_npub = ${SESSION_KEY_NPUB}
    `;
  });

  test('valid exchange preserves signer/actor identity and persists no capability plaintext', async () => {
    const sessionExchange = await exchangeRequest({
      repository_id: repositoryId,
      actor_id: ownerId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      requested_scopes: ['git.fetch'],
      session_id: 'workspace-session-key',
    }, sessionKeySecret);
    expect(sessionExchange.response.status).toBe(201);
    expect(sessionExchange.json.actor_id).toBe(ownerId);
    expect(sessionExchange.json.signer_npub).toBe(SESSION_KEY_NPUB);
    expect(sessionExchange.json.capability).toBeString();
    expect(sessionExchange.json.capability.length).toBeGreaterThan(40);
    const plaintext = sessionExchange.json.capability as string;

    const [persisted] = await sql<any[]>`
      SELECT capability_hash, capability_hash_prefix, repository_id, actor_id,
             signer_npub, scopes, audience, git_service, policy_revision,
             ref_constraints, session_id, expires_at, revoked_at
      FROM git_capabilities WHERE id = ${sessionExchange.json.capability_id}
    `;
    expect(persisted.capability_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(plaintext);
    const [exchange] = await sql<any[]>`
      SELECT event_id, body_sha256, signer_npub, actor_id, repository_id, decision, reason_code
      FROM git_credential_exchange_events
      WHERE actor_id = ${ownerId} ORDER BY consumed_at DESC LIMIT 1
    `;
    expect(JSON.stringify(exchange)).not.toContain(plaintext);
    const audit = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/audit-events`, 'GET', ownerSecret);
    expect(audit.response.status).toBe(200);
    expect(JSON.stringify(audit.json)).not.toContain(plaintext);
    expect(process.argv.join(' ')).not.toContain(plaintext);
  });

  test('introspection fails closed for service auth and all capability bindings', async () => {
    const readerExchange = await exchangeRequest({
      repository_id: repositoryId,
      actor_id: readerId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      requested_scopes: ['git.fetch'],
    }, readerSecret);
    expect(readerExchange.response.status).toBe(201);
    const base = {
      capability: readerExchange.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      required_scope: 'git.fetch',
    };
    const configuredInternalToken = config.git.internalServiceToken;
    config.git.internalServiceToken = '';
    const unconfigured = await internalRequest('/api/v4/git/internal/capabilities/introspect', base);
    expect(unconfigured.response.status).toBe(503);
    expect(unconfigured.json.code).toBe('git_internal_auth_unconfigured');
    config.git.internalServiceToken = configuredInternalToken;
    const noAuth = await internalRequest('/api/v4/git/internal/capabilities/introspect', base, '');
    expect(noAuth.response.status).toBe(401);
    expect(noAuth.json.code).toBe('git_internal_auth_invalid');
    const wrongAuth = await internalRequest('/api/v4/git/internal/capabilities/introspect', base, 'x'.repeat(INTERNAL_TOKEN.length));
    expect(wrongAuth.response.status).toBe(401);
    const active = await internalRequest('/api/v4/git/internal/capabilities/introspect', base);
    expect(active.response.status).toBe(200);
    expect(active.json).toMatchObject({ active: true, reason_code: 'git_capability_active', repository_id: repositoryId, actor_id: readerId, actor_display_name: 'Git Reader' });
    expect(JSON.stringify(active.json)).not.toContain(readerExchange.json.capability);
    const wrongRepository = await internalRequest('/api/v4/git/internal/capabilities/introspect', { ...base, repository_id: secondRepositoryId });
    expect(wrongRepository.json).toEqual({ active: false, reason_code: 'git_capability_wrong_repository' });
    const wrongAudience = await internalRequest('/api/v4/git/internal/capabilities/introspect', { ...base, audience: `${GIT_AUDIENCE}-wrong` });
    expect(wrongAudience.json).toEqual({ active: false, reason_code: 'git_capability_wrong_audience' });
    const wrongService = await internalRequest('/api/v4/git/internal/capabilities/introspect', { ...base, service: 'receive-pack', required_scope: 'git.push.unprotected' });
    expect(wrongService.json).toEqual({ active: false, reason_code: 'git_capability_wrong_service' });
    await sql`
      UPDATE git_capabilities
      SET issued_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${readerExchange.json.capability_id}
    `;
    const expired = await internalRequest('/api/v4/git/internal/capabilities/introspect', base);
    expect(expired.json).toEqual({ active: false, reason_code: 'git_capability_expired' });

    const pushExchange = await exchangeRequest({
      repository_id: repositoryId,
      actor_id: contributorId,
      audience: GIT_AUDIENCE,
      service: 'receive-pack',
      requested_scopes: ['git.push.unprotected'],
    }, contributorSecret);
    expect(pushExchange.response.status).toBe(201);
    expect(pushExchange.json.actor_id).toBe(contributorId);
    expect(pushExchange.json.signer_npub).toBe(CONTRIBUTOR_NPUB);
    const pushBase = {
      capability: pushExchange.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'receive-pack',
      required_scope: 'git.push.unprotected',
    };
    const missingScope = await internalRequest('/api/v4/git/internal/capabilities/introspect', { ...pushBase, required_scope: 'git.push.branch_create' });
    expect(missingScope.json).toEqual({ active: false, reason_code: 'git_capability_missing_scope' });
    const revoked = await internalRequest('/api/v4/git/internal/capabilities/revoke', {
      capability_id: pushExchange.json.capability_id,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      reason: 'acceptance test revocation',
    });
    expect(revoked.response.status).toBe(200);
    expect(revoked.json.reason_code).toBe('git_capability_revoked');
    const afterRevoke = await internalRequest('/api/v4/git/internal/capabilities/introspect', pushBase);
    expect(afterRevoke.json).toEqual({ active: false, reason_code: 'git_capability_revoked' });
  });

  test('policy revision changes invalidate capabilities and audit evidence is immutable', async () => {
    const issued = await exchangeRequest({
      repository_id: repositoryId,
      actor_id: readerId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      requested_scopes: ['git.fetch'],
      correlation_id: 'stale-policy-acceptance',
    }, readerSecret);
    expect(issued.response.status).toBe(201);
    const grant = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/grants`, 'POST', ownerSecret, {
      principal_type: 'actor', principal_id: spareId, permission: 'git.repo.read',
    });
    expect(grant.response.status).toBe(201);
    const stale = await internalRequest('/api/v4/git/internal/capabilities/introspect', {
      capability: issued.json.capability,
      repository_id: repositoryId,
      audience: GIT_AUDIENCE,
      service: 'upload-pack',
      required_scope: 'git.fetch',
    });
    expect(stale.json).toEqual({ active: false, reason_code: 'git_capability_stale_policy' });

    const [event] = await sql<{ id: string }[]>`SELECT id FROM git_audit_events WHERE repository_id = ${repositoryId} LIMIT 1`;
    let immutableError: unknown;
    try {
      await sql`UPDATE git_audit_events SET reason_code = 'tampered' WHERE id = ${event.id}`;
    } catch (error) {
      immutableError = error;
    }
    expect(immutableError).toBeDefined();
    const secretColumns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('git_capabilities', 'git_credential_exchange_events', 'git_nip98_mutation_events', 'git_audit_events')
        AND column_name IN ('capability', 'plaintext_capability', 'bearer_token', 'authorization')
    `;
    expect(secretColumns).toHaveLength(0);
  });

  test('Forgejo webhooks require HMAC and deduplicate delivery evidence transactionally', async () => {
    const configuredSecret = config.git.forgejoWebhookSecret;
    config.git.forgejoWebhookSecret = 'fixture-webhook-secret-0000000000000000';
    const [binding] = await sql<any[]>`
      SELECT forgejo_owner, forgejo_repository FROM git_forgejo_repository_bindings
      WHERE repository_id = ${repositoryId}
    `;
    const body = JSON.stringify({
      repository: { name: binding.forgejo_repository, owner: { username: binding.forgejo_owner } },
      sender: { username: 'wm-shadow-fixture' }, ref: 'refs/heads/work/webhook-fixture',
      before: '1'.repeat(40), after: '2'.repeat(40), forced: false, created: false, deleted: false,
      head_commit: { timestamp: new Date().toISOString() },
    });
    const request = (signature: string) => app.request('/api/v4/git/forgejo/webhooks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-forgejo-signature': signature,
        'x-forgejo-delivery': 'fixture-delivery-1', 'x-forgejo-event': 'push',
      },
      body,
    });
    const invalid = await request('0'.repeat(64));
    expect(invalid.status).toBe(401);
    const signature = createHmac('sha256', config.git.forgejoWebhookSecret).update(body, 'utf8').digest('hex');
    const accepted = await request(signature);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ duplicate: false, evidence: { repository_id: repositoryId, ref_name: 'refs/heads/work/webhook-fixture' } });
    const duplicate = await request(signature);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ duplicate: true });
    const [counts] = await sql<any[]>`
      SELECT
        (SELECT COUNT(*)::int FROM git_forgejo_webhook_deliveries WHERE delivery_id = 'fixture-delivery-1') AS deliveries,
        (SELECT COUNT(*)::int FROM git_forgejo_events WHERE delivery_id = 'fixture-delivery-1') AS events,
        (SELECT COUNT(*)::int FROM git_audit_events WHERE source = 'forgejo' AND correlation_id = 'fixture-delivery-1') AS audit
    `;
    expect(counts).toMatchObject({ deliveries: 1, events: 1, audit: 1 });
    config.git.forgejoWebhookSecret = configuredSecret;
  });
});

const bootstrapSecret = new Uint8Array(32).fill(97);
let bootstrapId: string;
describe('headless identity authority and races', () => {
  test('no-grant member can request bootstrap repeatedly without acquiring repository grants', async () => {
    const [actor] = await sql`INSERT INTO flightdeck_pg_actors (npub, kind, display_name) VALUES (${nip19.npubEncode(getPublicKey(bootstrapSecret))}, 'agent', 'Headless actor') RETURNING id`;
    bootstrapId = actor.id;
    await sql`INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id) VALUES (${workspaceId}, ${bootstrapId}, 'agent', ${ownerId})`;
    const before = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM git_repository_grants`;
    const path = `/api/v4/git/workspaces/${workspaceId}/actor-bootstrap`;
    for (let i = 0; i < 2; i++) {
      const result = await publicRequest(path, 'POST', bootstrapSecret, {});
      expect(result.response.status).toBe(202);
      expect(result.json.bootstrap.account_state).toBe('pending');
      expect(result.json.bootstrap.actor_id).toBe(bootstrapId);
    }
    const rows = await sql`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${bootstrapId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].forgejo_user_id).toBeNull();
    const after = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM git_repository_grants`;
    expect(after[0].count).toBe(before[0].count);
    const denied = await exchangeRequest({ repository_id: repositoryId, audience: GIT_AUDIENCE }, bootstrapSecret);
    expect(denied.response.status).toBe(404);
    const foreign = await publicRequest(`/api/v4/git/workspaces/${foreignWorkspaceId}/actor-bootstrap`, 'POST', bootstrapSecret, {});
    expect(foreign.response.status).toBe(404);
  });

  test('simultaneous provider binding writers cannot replace an immutable provider ID', async () => {
    const { syncForgejoActorBinding } = await import('../src/services/forgejo-authority');
    const [alias] = await sql`SELECT desired_username FROM git_forgejo_actor_aliases WHERE actor_id = ${bootstrapId}`;
    const orgPath = `/api/v4/git/internal/forgejo/organizations/${workspaceId}`;
    const desired = async () => (await (await app.request(`${orgPath}/desired-state`, {
      headers: { 'x-wingman-git-service-token': INTERNAL_TOKEN },
    })).json()) as any;
    const before = await desired();
    expect(before.actor_access.some((actor: any) => actor.actor_id === bootstrapId)).toBeFalse();
    const results = await Promise.allSettled([71001, 71002].map(forgejoUserId => syncForgejoActorBinding({
      actorId: bootstrapId, forgejoUserId, username: alias.desired_username, desiredUsername: alias.desired_username,
    }, sql)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('git_forgejo_actor_binding_conflict');
    const [linked] = await sql`SELECT forgejo_user_id FROM git_forgejo_actor_aliases WHERE actor_id = ${bootstrapId}`;
    const id = Number(linked.forgejo_user_id);
    for (const ok of [true, false]) {
      const stale = await internalRequest(`${orgPath}/ack`, { forgejo_owner: before.forgejo_owner, desired_generation: before.desired_generation, ok });
      expect(stale.response.status).toBe(409);
    }
    const current = await desired();
    expect(current.state).toBe('pending');
    expect(current.desired_generation).toBeGreaterThan(before.desired_generation);
    expect(current.actor_access).toContainEqual(expect.objectContaining({ actor_id: bootstrapId, organization_role: 'member' }));
    expect((await publicRequest(`/api/v4/git/workspaces/${workspaceId}/actor-bootstrap`, 'GET', bootstrapSecret)).json.bootstrap.state).toBe('pending');
    expect((await internalRequest(`${orgPath}/ack`, { forgejo_owner: current.forgejo_owner, desired_generation: current.desired_generation, ok: true })).response.status).toBe(200);
    expect((await publicRequest(`/api/v4/git/workspaces/${workspaceId}/actor-bootstrap`, 'GET', bootstrapSecret)).json.bootstrap.state).toBe('ready');
    expect(await sql`SELECT id FROM git_repository_grants WHERE principal_actor_id = ${bootstrapId} AND revoked_at IS NULL`).toHaveLength(0);

    await expect(syncForgejoActorBinding({ actorId: bootstrapId, forgejoUserId: id === 71001 ? 71002 : 71001,
      username: alias.desired_username, desiredUsername: alias.desired_username }, sql)).rejects.toMatchObject({ code: 'git_forgejo_actor_binding_conflict' });
    await expect(syncForgejoActorBinding({ actorId: bootstrapId, forgejoUserId: id,
      username: alias.desired_username, desiredUsername: alias.desired_username }, sql)).resolves.toMatchObject({ state: 'ready' });
  });

  test('a newer alias request survives both stale success and stale failure acknowledgements', async () => {
    const { syncForgejoActorBinding, acknowledgeForgejoActorAlias } = await import('../src/services/forgejo-authority');
    const [before] = await sql`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${bootstrapId}`;
    const request = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/actor-username`, 'PUT', bootstrapSecret, { username: 'new-spare-alias' });
    expect(request.response.status).toBe(202);
    await expect(syncForgejoActorBinding({ actorId: bootstrapId, forgejoUserId: Number(before.forgejo_user_id), username: before.desired_username,
      desiredUsername: before.desired_username }, sql)).rejects.toMatchObject({ code: 'git_forgejo_actor_binding_conflict' });
    await expect(acknowledgeForgejoActorAlias({ actorId: bootstrapId, desiredUsername: before.desired_username, ok: false, errorCode: 'old_failure' }, sql))
      .rejects.toMatchObject({ code: 'git_actor_username_reconciliation_stale' });
    const [after] = await sql`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${bootstrapId}`;
    expect(after.desired_username).toBe('new-spare-alias');
    expect(after.state).toBe('pending');
    expect(after.last_error_code).toBeNull();
    expect(after.forgejo_user_id).toBe(before.forgejo_user_id);
  });
});

test('revocation during pending bootstrap remains effective after provider linking', async () => {
  const { syncForgejoActorBinding } = await import('../src/services/forgejo-authority');
  const grant = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/grants`, 'POST', ownerSecret,
    { principal_type: 'actor', principal_id: bootstrapId, permission: 'git.repo.read' });
  expect(grant.response.status).toBe(201);
  const revoked = await publicRequest(`/api/v4/git/workspaces/${workspaceId}/repositories/${repositoryId}/grants/${grant.json.grant.grant_id}`, 'DELETE', ownerSecret);
  expect(revoked.response.status).toBe(200);
  const [alias] = await sql`SELECT * FROM git_forgejo_actor_aliases WHERE actor_id = ${bootstrapId}`;
  expect(alias.state).toBe('pending');
  await syncForgejoActorBinding({ actorId: bootstrapId, forgejoUserId: Number(alias.forgejo_user_id), username: alias.desired_username, desiredUsername: alias.desired_username }, sql);
  const denied = await exchangeRequest({ repository_id: repositoryId, audience: GIT_AUDIENCE }, bootstrapSecret);
  expect(denied.response.status).toBe(404);
  const grants = await sql`SELECT * FROM git_repository_grants WHERE principal_actor_id = ${bootstrapId} AND revoked_at IS NULL`;
  expect(grants).toHaveLength(0);
});
