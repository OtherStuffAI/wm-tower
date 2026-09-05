/** Real Forgejo + Tower + Autopilot broker + compiled shipped helper. Synthetic identities only. */
import assert from 'node:assert/strict';
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
    const tags = [['u', url], ['method', method], ...(raw ? [['payload', createHash('sha256').update(raw).digest('hex')]] : [])];
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, owner.key);
    const r = await fetch(url, { method, headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`, 'content-type': 'application/json' }, body: raw });
    const result = await r.json() as any; assert(r.ok, JSON.stringify(result)); return result;
  };
  const root = `/api/v4/git/workspaces/${workspace.id}`;
  await ownerRequest(`${root}/namespace`, 'PUT', { namespace: `headless-${suffix}` });
  const created = await ownerRequest(`${root}/repositories`, 'POST', { slug: 'allowed', display_name: 'Allowed' });
  const repositoryId = created.repository.repository_id;
  await ownerRequest(`${root}/repositories/${repositoryId}/grants`, 'POST', { principal_type: 'actor', principal_id: agent.id, permission: 'git.repo.write' });
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
  console.log(JSON.stringify({ passed: true, provider: 'Forgejo 16.0.3', helper: 'compiled shipped git-credential-wingman', brokerCalls, freshActor: agent.id, workspaceId: workspace.id, repositoryId, clone: 'pass', fetch: 'pass', workPush: 'pass', protectedPush: 'denied', noGrantClone: 'denied with stage/status/code', foreignWorkspace: 'denied', repeatedConcurrentBootstrap: 'one provider account', browserLogin: false, grantRevokeRestore: false }, null, 2));
} finally {
  for (const server of servers.reverse()) server.stop(true);
  await sql.end();
  await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.end();
  await rm(directory, { recursive: true, force: true });
}
