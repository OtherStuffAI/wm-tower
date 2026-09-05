/** Real Forgejo + Tower + Autopilot broker + compiled shipped helper. Synthetic identities only. */
import assert from 'node:assert/strict';
import { revokeGitRepositoryGrant } from '../../../src/services/git-authority';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from 'nostr-tools';
import postgres from 'postgres';
import { config } from '../../../src/config';
import { setDb } from '../../../src/db';
import { splitSqlStatements } from '../../../src/schema/sql-statements';
import { createApp } from '../../../src/server';
import { createForgejoGateway } from '../../../src/forgejo/gateway';
import { reconcileForgejoActorAliases } from '../../../src/forgejo/reconcile-identities';
import { reconcilePendingForgejoOrganizations } from '../../../src/forgejo/reconcile-organizations';

const sharingSmoke = process.env.FORGEJO_SHARING_SMOKE === '1';
const autopilot = resolve(process.env.AUTOPILOT_REPO || '../autopilot');
const { CapabilityBroker, buildDefaultAgentCapabilityPolicy } = await import(`${autopilot}/src/signing/capability-broker.ts`);
const { TowerGitCredentialBroker } = await import(`${autopilot}/src/git/tower-git-credential-broker.ts`);
const directory = await mkdtemp(join(tmpdir(), 'headless-forgejo-'));
const database = `headless_${randomUUID().replaceAll('-', '')}`;
const admin = postgres({ host: '127.0.0.1', port: 35432, username: 'postgres', password: 'headless-fixture-only', database: 'postgres', onnotice: () => {} });
await admin.unsafe(`CREATE DATABASE "${database}"`);
const sql = postgres({ host: '127.0.0.1', port: 35432, username: 'postgres', password: 'headless-fixture-only', database, onnotice: () => {} });
setDb(sql);
const servers: any[] = [];
let browser: any;
const compose = ['docker', 'compose', '--project-name', 'tower-headless-bootstrap-fixture', '-f', 'tests/fixtures/headless-forgejo/docker-compose.yml', 'exec', '-T', '--user', 'git', 'forgejo', 'forgejo'];
async function command(args: string[], env?: Record<string, string | undefined>, cwd?: string, allowFailure = false) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status && !allowFailure) throw new Error(`${args[0]} ${args[1]} failed (${status}): ${stderr.slice(0, 1800)}`);
  return { stdout, stderr, status };
}
try {
  for (const statement of splitSqlStatements(await Bun.file('src/schema/001_init.sql').text())) await sql.unsafe(statement);
  const suffix = randomUUID().slice(0, 8);
  const accounts = ['owner', 'agent', 'denied'].map(name => {
    const key = generateSecretKey(); const pubkey = getPublicKey(key);
    return { name, key, pubkey, npub: nip19.npubEncode(pubkey), id: '', sessionId: randomUUID() };
  });
  for (const account of accounts) {
    const [row] = await sql`INSERT INTO flightdeck_pg_actors (npub, kind, display_name) VALUES (${account.npub}, ${account.name === 'owner' ? 'human' : 'agent'}, ${account.name}) RETURNING id`;
    account.id = row.id;
  }
  const [owner, agent, denied] = accounts;
  const [workspace] = await sql`INSERT INTO flightdeck_pg_workspaces (tower_service_npub, workspace_service_npub, workspace_owner_npub, app_npub, name, slug, created_by_actor_id)
    VALUES (${config.service.npub || 'npub1fixturetower'}, ${'npub1fixture' + suffix}, ${owner.npub}, ${config.flightDeck.appNpub}, 'Headless fixture', ${'headless-' + suffix}, ${owner.id}) RETURNING id`;
  for (const account of accounts) await sql`INSERT INTO flightdeck_pg_workspace_memberships (workspace_id, actor_id, role, created_by_actor_id) VALUES (${workspace.id}, ${account.id}, ${account.name === 'owner' ? 'owner' : 'agent'}, ${owner.id})`;
  const towerApp = createApp();
  const tower = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: towerApp.fetch }); servers.push(tower);
  const towerUrl = `http://127.0.0.1:${tower.port}`;
  const discovery = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch(request) {
    const origin = new URL(request.url).origin;
    return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, userinfo_endpoint: `${origin}/userinfo`, jwks_uri: `${origin}/keys`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
  } }); servers.push(discovery);
  const identityName = `identity-${suffix}`, controlName = `control-${suffix}`, sourceName = `tower-${suffix}`;
  for (const [name, isAdmin] of [[identityName, true], [controlName, false]] as const) {
    await command([...compose, 'admin', 'user', 'create', '--username', name, '--email', `${name}@fixture.invalid`, '--random-password', '--must-change-password=false', ...(isAdmin ? ['--admin'] : [])]);
  }
  const identityToken = (await command([...compose, 'admin', 'user', 'generate-access-token', '--username', identityName, '--token-name', 'fixture', '--scopes', 'write:admin,read:user', '--raw'])).stdout.trim();
  const controlToken = (await command([...compose, 'admin', 'user', 'generate-access-token', '--username', controlName, '--token-name', 'fixture', '--scopes', 'all', '--raw'])).stdout.trim();
  await command([...compose, 'admin', 'auth', 'add-oauth', '--name', sourceName, '--provider', 'openidConnect', '--key', 'fixture', '--secret', 'fixture-only', '--auto-discover-url', `http://host.docker.internal:${discovery.port}/.well-known/openid-configuration`]);
  const sources = (await command([...compose, 'admin', 'auth', 'list'])).stdout;
  const sourceId = Number(sources.split('\n').find(line => line.includes(sourceName))?.trim().split(/\s+/)[0]);
  assert(sourceId > 0);
  const forgejoUrl = 'http://127.0.0.1:33300';
  const providerUsers = async () => await (await fetch(`${forgejoUrl}/api/v1/admin/users?limit=1000`, { headers: { authorization: `token ${identityToken}` } })).json() as any[];
  assert(!(await providerUsers()).some(user => user.login_name === agent.id));
  await command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const gatewayApp = createForgejoGateway({ towerUrl, forgejoUrl, internalServiceToken: config.git.internalServiceToken, audience: config.git.audience });
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(join(directory, 'key.pem')), cert: Bun.file(join(directory, 'cert.pem')) }, fetch: gatewayApp.fetch }); servers.push(gateway);
  const gatewayUrl = `https://127.0.0.1:${gateway.port}`;
  config.git.gatewayOrigins = [gatewayUrl];
  const subscriptions = accounts.map(account => ({ lifecycleStatus: 'active', workspaceId: workspace.id, botNpub: account.npub, backendBaseUrl: towerUrl, sourceAppNpub: config.flightDeck.appNpub, towerServiceNpub: config.service.npub || null }));
  const snapshots = accounts.map(account => ({ id: account.sessionId, agent: 'codex', port: 0, status: 'running', startedAt: new Date().toISOString(), npub: owner.npub, metadata: { agentChatBotNpub: account.npub }, command: [], workingDirectory: directory, logs: [] }));
  const keyRecord = (npub: string) => { const account = accounts.find(a => a.npub === npub); return account ? { id: account.id, userNpub: owner.npub, botNpub: account.npub, botPubkeyHex: account.pubkey, isActive: 1 } : null; };
  let brokerCalls = 0;
  const broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForUser: () => keyRecord(agent.npub), getActiveKeyForBotNpub: keyRecord },
    keyVault: { withKey: async (record: any, operation: any) => operation(new Uint8Array(accounts.find(account => account.npub === record.botNpub)!.key)) },
    getSession: (id: string) => snapshots.find(snapshot => snapshot.id === id) ?? null,
    gitCredential: new TowerGitCredentialBroker({ listSubscriptions: () => subscriptions }), audit: () => {},
  });
  const brokerServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url); if (url.pathname.endsWith('/git-credential')) brokerCalls++;
    return await broker.handle(request, url, request.method) ?? new Response('', { status: 404 });
  } }); servers.push(brokerServer);
  const brokerUrl = `http://127.0.0.1:${brokerServer.port}`;
  const envFor = (account: typeof agent) => {
    const capability = broker.issueSessionCapability({ sessionId: account.sessionId, ownerNpub: owner.npub, botNpub: account.npub, workspaceId: workspace.id, policy: buildDefaultAgentCapabilityPolicy({ towerUrl, autopilotUrl: brokerUrl }) });
    return { ...process.env, WINGMAN_BROKER_URL: brokerUrl, WINGMAN_URL: brokerUrl, SESSION_ID: account.sessionId, WINGMAN_CAPABILITY: capability.token,
      PATH: `${directory}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSL_CAINFO: join(directory, 'cert.pem'),
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: `credential.${gatewayUrl}.helper`, GIT_CONFIG_VALUE_1: 'wingman', GIT_CONFIG_KEY_2: `credential.${gatewayUrl}.useHttpPath`, GIT_CONFIG_VALUE_2: 'true' };
  };
  const environments = new Map(accounts.map(account => [account.name, envFor(account)]));
  const cli = async (account: typeof agent, ...args: string[]) => JSON.parse((await command(['bun', join(autopilot, 'clis/wingman.ts'), 'forgejo', ...args], environments.get(account.name))).stdout);
  const ownerRequest = async (path: string, method: string, body?: any) => {
    const url = towerUrl + path, raw = body === undefined ? undefined : JSON.stringify(body);
    const tags = [['u', url], ['method', method], ['nonce', randomUUID()], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, owner.key);
    const r = await fetch(url, { method, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json' }, body: raw });
    const result = await r.json() as any; assert(r.ok, JSON.stringify(result)); return result;
  };
  const root = `/api/v4/git/workspaces/${workspace.id}`;
  await ownerRequest(`${root}/namespace`, 'PUT', { namespace: `headless-${suffix}` });
  const created = await ownerRequest(`${root}/repositories`, 'POST', { slug: 'allowed', display_name: 'Allowed' });
  const repositoryId = created.repository.repository_id;
  if (!sharingSmoke) await ownerRequest(`${root}/repositories/${repositoryId}/grants`, 'POST', { principal_type: 'actor', principal_id: agent.id, permission: 'git.repo.write' });
  for (const account of accounts) {
    await cli(account, 'username', 'set', '--username', `${account.name}-${suffix}`);
    assert.equal((await cli(account, 'bootstrap', 'request')).bootstrap.account_state, 'pending');
  }
  const identityOptions = { towerUrl, forgejoUrl, internalToken: config.git.internalServiceToken, identityToken, sourceId };
  // Two workers race creation; canonical email/provider ID and Tower CAS must keep one account.
  await Promise.all([reconcileForgejoActorAliases(identityOptions), reconcileForgejoActorAliases(identityOptions)]);
  await reconcileForgejoActorAliases(identityOptions);
  await reconcilePendingForgejoOrganizations({ towerUrl, forgejoUrl, internalToken: config.git.internalServiceToken, controlToken });
  for (const account of accounts) assert.equal((await cli(account, 'bootstrap', 'status')).bootstrap.state, 'ready');
  assert.equal((await providerUsers()).filter(user => user.login_name === agent.id && user.source_id === sourceId).length, 1);
  await cli(agent, 'bootstrap', 'request'); await reconcileForgejoActorAliases(identityOptions);
  assert.equal((await providerUsers()).filter(user => user.login_name === agent.id && user.source_id === sourceId).length, 1);
  const reconcile = () => reconcilePendingForgejoOrganizations({ towerUrl, forgejoUrl, internalToken: config.git.internalServiceToken, controlToken });
  const sharingPath = `/api/v4/git/forgejo/sharing/headless-${suffix}/allowed`;
  let page: any, groupId: string;
  let signedWrite: { url: string; headers: Record<string, string>; body: string } | undefined;
  const sharingRequest = async (account: typeof owner, method: string, body?: any) => {
    const url = towerUrl + sharingPath, raw = body === undefined ? undefined : JSON.stringify(body);
    const tags = [['u', url], ['method', method], ['nonce', randomUUID()], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, account.key);
    const response = await fetch(url, { method, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json' }, body: raw });
    return { status: response.status, body: await response.json() as any };
  };
  const uiSet = async (principal: string, access: string) => {
    await page.locator('#principal').selectOption(principal);
    await page.locator('#access').selectOption(access);
    await page.getByRole('button', { name: 'Save access', exact: true }).click();
    await page.locator('#status').filter({ hasText: 'Sharing is saved in Tower.' }).waitFor();
    assert.match(await page.locator('#status').innerText(), /Sharing is saved/);
    await reconcile();
    await page.getByRole('button', { name: 'Load sharing with Nostr' }).click();
    await page.locator('#status').filter({ hasText: 'Sharing is applied.' }).waitFor();
    assert.equal(await page.locator('#status').innerText(), 'Sharing is applied.');
  };
  if (sharingSmoke) {
    const [group] = await sql`INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id) VALUES (${workspace.id}, 'Contributors', 'custom', ${owner.id}) RETURNING id`;
    groupId = group.id;
    await sql`INSERT INTO flightdeck_pg_group_memberships (workspace_id, group_id, actor_id, created_by_actor_id) VALUES (${workspace.id}, ${groupId}, ${agent.id}, ${owner.id})`;
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.exposeFunction('fixtureSign', (event: any) => finalizeEvent(event, owner.key));
    await page.addInitScript('window.nostr = { signEvent: event => window.fixtureSign(event) };');
    page.on('request', (r: any) => { if (r.method() === 'POST' && r.url().includes('/forgejo/sharing/')) signedWrite = { url: r.url(), headers: r.headers(), body: r.postData() }; });
    await page.goto(`${gatewayUrl}/headless-${suffix}/allowed/settings/collaboration`);
    await page.getByRole('button', { name: 'Load sharing with Nostr' }).click();
    await page.waitForSelector('#sharing:not([hidden])');
    assert.equal((await sharingRequest(agent, 'GET')).status, 404);
    assert.equal((await sharingRequest(denied, 'GET')).status, 404);
    const snapshot = (await sharingRequest(owner, 'GET')).body;
    const target = snapshot.principals.find((p: any) => p.principal_id === agent.id);
    const mutation = { ...target, expected_policy_revision: snapshot.policy_revision, access: 'write' };
    assert.equal((await sharingRequest(agent, 'POST', mutation)).status, 404);
    assert.equal((await sharingRequest(owner, 'POST', { ...mutation, forgejo_user_id: target.forgejo_user_id + 100000 })).status, 409);
    assert.equal((await sharingRequest(owner, 'POST', { ...mutation, principal_id: randomUUID() })).status, 409);
    assert.equal((await sharingRequest(owner, 'POST', { ...mutation, principal_type: 'group', principal_id: randomUUID() })).status, 404);
    const [foreignActor] = await sql`INSERT INTO flightdeck_pg_actors (npub, kind, display_name) VALUES (${nip19.npubEncode(getPublicKey(generateSecretKey()))}, 'agent', 'Foreign fixture actor') RETURNING id`;
    assert.equal((await sharingRequest(owner, 'POST', { ...mutation, principal_id: foreignActor.id })).status, 409);
    const ownerPrincipal = snapshot.principals.find((p: any) => p.principal_id === owner.id);
    assert.equal((await sharingRequest(owner, 'POST', { ...ownerPrincipal, expected_policy_revision: snapshot.policy_revision, access: 'none' })).status, 409);
    // An empty administrator group must not permit removing the last actual admin.
    const [emptyGroup] = await sql`INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id) VALUES (${workspace.id}, 'Empty administrators', 'custom', ${owner.id}) RETURNING id`;
    const emptyPrincipal = { principal_type: 'group', principal_id: emptyGroup.id };
    assert.equal((await sharingRequest(owner, 'POST', { ...emptyPrincipal, expected_policy_revision: snapshot.policy_revision, access: 'admin' })).status, 202);
    const withEmptyGroup = (await sharingRequest(owner, 'GET')).body;
    const blockedRemoval = await sharingRequest(owner, 'POST', { ...ownerPrincipal, expected_policy_revision: withEmptyGroup.policy_revision, access: 'none' });
    assert.equal(blockedRemoval.body.code, 'git_last_admin_grant');
    const ownerAdmin = withEmptyGroup.grants.find((g: any) => g.principal_actor_id === owner.id && g.permission === 'git.repo.admin');
    await assert.rejects(revokeGitRepositoryGrant(workspace.id, repositoryId, ownerAdmin.grant_id, owner.npub, owner.npub, sql), { code: 'git_last_admin_grant' });
    assert.equal((await sharingRequest(owner, 'POST', { ...emptyPrincipal, expected_policy_revision: withEmptyGroup.policy_revision, access: 'none' })).status, 202);
    // A populated nested group really can retain administration and restore a direct admin.
    const [parentGroup] = await sql`INSERT INTO flightdeck_pg_groups (workspace_id, name, kind, created_by_actor_id) VALUES (${workspace.id}, 'Parent administrators', 'custom', ${owner.id}) RETURNING id`;
    await sql`INSERT INTO flightdeck_pg_group_edges (workspace_id, parent_group_id, child_group_id, created_by_actor_id) VALUES (${workspace.id}, ${parentGroup.id}, ${groupId}, ${owner.id})`;
    const parentPrincipal = { principal_type: 'group', principal_id: parentGroup.id };
    const saveCurrent = async (account: typeof owner, principal: any, access: string) => {
      const current = (await sharingRequest(account, 'GET')).body;
      assert.equal((await sharingRequest(account, 'POST', { ...principal, expected_policy_revision: current.policy_revision, access })).status, 202);
    };
    await saveCurrent(owner, parentPrincipal, 'admin');
    await saveCurrent(owner, ownerPrincipal, 'none');
    await saveCurrent(agent, ownerPrincipal, 'admin');
    await saveCurrent(owner, parentPrincipal, 'none');
    await page.getByRole('button', { name: 'Load sharing with Nostr' }).click();
    await page.locator('#status').filter({ hasText: 'Sharing is saved in Tower.' }).waitFor();
    // Reproduce the screenshot's provider-only tower-members repository assignment.
    const teamAttachment = await fetch(`${forgejoUrl}/api/v1/repos/headless-${suffix}/allowed/teams/tower-members`, {
      method: 'PUT', headers: { authorization: `token ${controlToken}` },
    });
    assert.equal(teamAttachment.status, 204);
    await uiSet(agent.id, 'write');
    const providerTeams = await fetch(`${forgejoUrl}/api/v1/repos/headless-${suffix}/allowed/teams`, { headers: { authorization: `token ${controlToken}` } });
    assert(!(await providerTeams.json() as any[]).some(t => t.name === 'tower-members'));

    const tampered = await fetch(signedWrite!.url, { method: 'POST', headers: signedWrite!.headers, body: JSON.stringify({ ...JSON.parse(signedWrite!.body), access: 'admin' }), tls: { rejectUnauthorized: false } } as any);
    assert.equal(tampered.status, 401);
    await page.screenshot({ path: process.env.SHARING_SCREENSHOT || '/tmp/forgejo-sharing-smoke.png', fullPage: true });
    const providerPermission = await fetch(`${forgejoUrl}/api/v1/repos/headless-${suffix}/allowed/collaborators/agent-${suffix}/permission`, { headers: { authorization: `token ${controlToken}` } });
    assert.equal((await providerPermission.json() as any).permission, 'write');
  }
  await command(['bun', 'build', '--compile', '--minify', 'src/git/git-credential-wingman.ts', '--outfile', join(directory, 'git-credential-wingman')], process.env, autopilot);
  assert.match((await command([join(directory, 'git-credential-wingman'), '--version'])).stdout, /git-credential-wingman/);
  const remote = `${gatewayUrl}/headless-${suffix}/allowed.git`, checkout = join(directory, 'checkout');
  await command(['git', 'clone', remote, checkout], environments.get('agent'));
  await command(['git', '-C', checkout, 'fetch', 'origin'], environments.get('agent'));
  assert(brokerCalls >= 2);
  const deniedClone = await command(['git', 'clone', remote, join(directory, 'denied')], environments.get('denied'), undefined, true);
  assert.notEqual(deniedClone.status, 0); assert.match(deniedClone.stderr, /repository resolution.*HTTP 404.*git_repository_not_found/);
  const foreign = await command(['bun', join(autopilot, 'clis/wingman.ts'), 'forgejo', 'bootstrap', 'request', '--workspace', randomUUID()], environments.get('agent'), undefined, true);
  assert.notEqual(foreign.status, 0);
  await command(['git', '-C', checkout, 'checkout', '-b', 'work/headless'], environments.get('agent'));
  await command(['git', '-C', checkout, '-c', 'user.name=Headless Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'test: headless helper'], environments.get('agent'));
  await command(['git', '-C', checkout, 'push', 'origin', 'HEAD:refs/heads/work/headless'], environments.get('agent'));
  const protectedPush = await command(['git', '-C', checkout, 'push', 'origin', 'HEAD:refs/heads/main'], environments.get('agent'), undefined, true);
  assert.notEqual(protectedPush.status, 0);
  if (sharingSmoke) {
    const helper = Bun.spawn([join(directory, 'git-credential-wingman'), 'get'], { env: environments.get('agent'), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    helper.stdin.write(`protocol=https\nhost=127.0.0.1:${gateway.port}\npath=headless-${suffix}/allowed.git\n\n`); helper.stdin.end();
    const credential = await new Response(helper.stdout).text(); assert.equal(await helper.exited, 0);
    const password = credential.split('\n').find(line => line.startsWith('password='))?.slice(9); assert(password);
    const oldCredentialProbe = async () => fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${Buffer.from('nostr:' + password).toString('base64')}` }, tls: { rejectUnauthorized: false } } as any);
    assert.equal((await oldCredentialProbe()).status, 200);
    const replay = signedWrite!;
    await uiSet(agent.id, 'read');
    assert.equal((await fetch(replay.url, { method: 'POST', headers: replay.headers, body: replay.body, tls: { rejectUnauthorized: false } } as any)).status, 409);
    assert.equal((await oldCredentialProbe()).status, 403);
    await command(['git', '-C', checkout, 'fetch', 'origin'], environments.get('agent'));
    const downgradedPush = await command(['git', '-C', checkout, 'push', 'origin', 'HEAD:refs/heads/work/downgraded'], environments.get('agent'), undefined, true);
    assert.notEqual(downgradedPush.status, 0);
    // Direct removal does not remove a separately authorized group grant.
    await uiSet(groupId!, 'read');
    const removeRow = page.locator('#rows tr').filter({ hasText: `agent-${suffix}` });
    await removeRow.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.locator('#status').filter({ hasText: 'Sharing is saved in Tower.' }).waitFor(); assert.match(await page.locator('#status').innerText(), /Sharing is saved/);
    await reconcile();
    await command(['git', '-C', checkout, 'fetch', 'origin'], environments.get('agent'));
    await page.getByRole('button', { name: 'Load sharing with Nostr' }).click(); await page.locator('#status').filter({ hasText: 'Sharing is applied.' }).waitFor();
    await page.locator('#rows tr').filter({ hasText: 'Contributors (group)' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await page.locator('#status').filter({ hasText: 'Sharing is saved in Tower.' }).waitFor(); await reconcile();
    assert.notEqual((await command(['git', '-C', checkout, 'fetch', 'origin'], environments.get('agent'), undefined, true)).status, 0);
    // Competing administrator intents cannot resurrect a newer removal.
    const snapshot = (await sharingRequest(owner, 'GET')).body;
    const target = snapshot.principals.find((p: any) => p.principal_id === agent.id);
    const intents = await Promise.all(['write', 'none'].map(access => sharingRequest(owner, 'POST', { ...target, access, expected_policy_revision: snapshot.policy_revision })));
    assert.deepEqual(intents.map(r => r.status).sort(), [202, 409]);
    const latest = (await sharingRequest(owner, 'GET')).body;
    assert.equal((await sharingRequest(owner, 'POST', { ...target, access: 'none', expected_policy_revision: latest.policy_revision })).status, 202);
    const { beginForgejoReconciliation, acknowledgeForgejoReconciliation, resolveForgejoRepositoryPath, readForgejoDesiredState } = await import('../../../src/services/forgejo-authority');
    const token = randomUUID(), desired = await beginForgejoReconciliation(repositoryId, token, sql);
    await readForgejoDesiredState(repositoryId, sql);
    assert.equal((await resolveForgejoRepositoryPath(`headless-${suffix}`, 'allowed', sql)).ready, false);
    await assert.rejects(beginForgejoReconciliation(repositoryId, randomUUID(), sql), { code: 'git_reconciliation_busy' });
    const during = (await sharingRequest(owner, 'GET')).body;
    assert.equal((await sharingRequest(owner, 'POST', { ...target, access: 'none', expected_policy_revision: during.policy_revision })).status, 202);
    await assert.rejects(acknowledgeForgejoReconciliation({ repositoryId, reconciliationToken: token, appliedPolicyRevision: desired.desired_policy_revision, ok: true }, sql), { code: 'git_reconciliation_stale' });
    assert.equal((await resolveForgejoRepositoryPath(`headless-${suffix}`, 'allowed', sql)).ready, false);
    await reconcile();
    assert.equal((await resolveForgejoRepositoryPath(`headless-${suffix}`, 'allowed', sql)).ready, true);
    await assert.rejects(acknowledgeForgejoReconciliation({ repositoryId, reconciliationToken: token, appliedPolicyRevision: desired.desired_policy_revision, ok: true }, sql), { code: 'git_reconciliation_token_invalid' });
    assert.equal((await sharingRequest(owner, 'POST', { ...target, access: 'write', expected_policy_revision: snapshot.policy_revision })).status, 409);
    assert.notEqual((await command(['git', '-C', checkout, 'fetch', 'origin'], environments.get('agent'), undefined, true)).status, 0);
    // Supported abandonment recovery: no provider writer is running in this fixture.
    const abandonedToken = randomUUID();
    const abandoned = await beginForgejoReconciliation(repositoryId, abandonedToken, sql);
    const recovered = await acknowledgeForgejoReconciliation({ repositoryId, reconciliationToken: abandonedToken, appliedPolicyRevision: abandoned.desired_policy_revision, ok: false, errorCode: 'git_operator_abandoned_attempt' }, sql);
    assert.equal(recovered.state, 'pending');
    assert.equal((await resolveForgejoRepositoryPath(`headless-${suffix}`, 'allowed', sql)).ready, false);
    await reconcile();
    await assert.rejects(acknowledgeForgejoReconciliation({ repositoryId, reconciliationToken: abandonedToken, appliedPolicyRevision: abandoned.desired_policy_revision, ok: true }, sql), { code: 'git_reconciliation_token_invalid' });
    const grants = (await sharingRequest(owner, 'GET')).body.grants;
    assert(grants.some((g: any) => g.principal_actor_id === owner.id && g.permission === 'git.repo.admin'));
    assert(!grants.some((g: any) => g.principal_actor_id === agent.id));
    console.log(JSON.stringify({ sharing: 'passed', browser: 'headless Chromium with synthetic Nostr signer', directAdd: 'write', downgrade: 'read; push denied; old credential denied', groupGrant: 'fetch survives direct removal', revocation: 'fetch denied', unknownForeignAndUnauthorized: 'denied', signedPayloadTamperingAndReplay: 'denied', providerOnlyTeam: 'removed', finalAdministratorRemoval: 'denied', concurrentIntents: 'one accepted / one stale', reconciliation: 'exclusive writer; stale ACK cannot restore readiness', identitiesAndOwnerGrant: 'preserved' }));
  }
  console.log(JSON.stringify({ passed: true, provider: 'Forgejo 16.0.3', helper: 'compiled shipped git-credential-wingman', brokerCalls, freshActor: agent.id, workspaceId: workspace.id, repositoryId, clone: 'pass', fetch: 'pass', workPush: 'pass', protectedPush: 'denied', noGrantClone: 'denied with stage/status/code', foreignWorkspace: 'denied', repeatedConcurrentBootstrap: 'one provider account', browserLogin: false, grantRevokeRestore: false }, null, 2));
} finally {
  if (browser) await browser.close();
  for (const server of servers.reverse()) server.stop(true);
  await sql.end();
  await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.end();
  await rm(directory, { recursive: true, force: true });
}
