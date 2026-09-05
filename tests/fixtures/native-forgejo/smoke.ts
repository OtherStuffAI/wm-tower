/** Real stock Forgejo acceptance. Synthetic fixture identities; no Tower permission records. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import postgres from 'postgres';
import { config } from '../../../src/config';
import { setDb } from '../../../src/db';
import { splitSqlStatements } from '../../../src/schema/sql-statements';
import { createApp } from '../../../src/server';
import { forgejoLoginIdentitySchema } from '../../../src/services/forgejo-login-identity';

const autopilot = resolve(process.env.AUTOPILOT_REPO || '../autopilot');
const { CapabilityBroker, buildDefaultAgentCapabilityPolicy } = await import(`${autopilot}/src/signing/capability-broker.ts`);
const { TowerGitCredentialBroker } = await import(`${autopilot}/src/git/tower-git-credential-broker.ts`);
const directory = await mkdtemp(join(tmpdir(), 'native-forgejo-'));
const database = `native_${randomUUID().replaceAll('-', '')}`;
const admin = postgres({ host: '127.0.0.1', port: 35442, username: 'postgres', password: 'native-fixture-only', database: 'postgres', onnotice: () => {} });
await admin.unsafe(`CREATE DATABASE "${database}"`);
const sql = postgres({ host: '127.0.0.1', port: 35442, username: 'postgres', password: 'native-fixture-only', database, onnotice: () => {} });
setDb(sql);
const servers: any[] = [];
const compose = ['docker', 'compose', '-p', 'tower-native-auth-fixture', '-f', 'tests/fixtures/native-forgejo/docker-compose.yml', 'exec', '-T', '--user', 'git', 'forgejo', 'forgejo'];
async function command(args: string[], env?: Record<string, string | undefined>, cwd?: string, allowFailure = false) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status && !allowFailure) throw new Error(`${args[0]} ${args[1]} failed (${status}): ${stderr.slice(0, 1800)}`);
  return { stdout, stderr, status };
}
const evidence: Record<string, unknown> = { provider: 'stock Forgejo 16.0.3', helper: 'compiled shipped git-credential-wingman', permissionAuthority: 'Forgejo only' };
try {
  for (const statement of splitSqlStatements(await Bun.file('src/schema/001_init.sql').text())) await sql.unsafe(statement);
  await sql.unsafe(forgejoLoginIdentitySchema);
  const suffix = randomUUID().slice(0, 8);
  const accounts = ['existing', 'fresh', 'unlisted'].map(name => {
    const key = generateSecretKey(); const pubkey = getPublicKey(key);
    return { name, key, pubkey, npub: nip19.npubEncode(pubkey), id: randomUUID(), sessionId: randomUUID() };
  });
  const [existing, fresh, unlisted] = accounts;
  await sql`INSERT INTO flightdeck_pg_actors (id, npub, kind, display_name) VALUES (${existing.id}, ${existing.npub}, 'agent', 'Existing fixture identity')`;
  // Fresh has no Tower actor/workspace/group/repository/grant at all.
  config.git.oidcIssuer = 'https://dev.otherstuff.studio:33110/api/v4/git/oidc';
  config.git.oidcClientId = 'forgejo-native-fixture';
  config.git.oidcClientSecret = 'fixture-only-client-secret-at-least-32-characters';
  config.git.oidcSigningKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  config.git.oidcRedirectUri = 'https://dev.otherstuff.studio:33310/user/oauth2/TowerNative/callback';
  (config.git as any).oidcAllowedNpubs = [existing.npub, fresh.npub];
  let towerAvailable = true, completions = 0;
  const app = createApp();
  const tower = Bun.serve({ hostname: '0.0.0.0', port: 33110, tls: { key: Bun.file('/tmp/tower-native-forgejo/key.pem'), cert: Bun.file('/tmp/tower-native-forgejo/cert.pem') }, fetch(request) {
    if (!towerAvailable) return new Response('Fixture: Tower unavailable', { status: 503 });
    if (new URL(request.url).pathname.endsWith('/authorize/complete')) completions++;
    return app.fetch(request);
  } }); servers.push(tower);
  const forgejoUrl = 'https://dev.otherstuff.studio:33310';
  const adminName = `admin-${suffix}`;
  await command([...compose, 'admin', 'user', 'create', '--username', adminName, '--email', `${adminName}@fixture.invalid`, '--random-password', '--must-change-password=false', '--admin']);
  const adminToken = (await command([...compose, 'admin', 'user', 'generate-access-token', '--username', adminName, '--token-name', 'fixture', '--scopes', 'all', '--raw'])).stdout.trim();
  const sources = (await command([...compose, 'admin', 'auth', 'list'])).stdout;
  if (!sources.includes('TowerNative')) await command([...compose, 'admin', 'auth', 'add-oauth', '--name', 'TowerNative', '--provider', 'openidConnect', '--key', config.git.oidcClientId, '--secret', config.git.oidcClientSecret, '--auto-discover-url', `${config.git.oidcIssuer}/.well-known/openid-configuration`]);
  const api = async (path: string, method = 'GET', body?: unknown, token = adminToken) => {
    const response = await fetch(`${forgejoUrl}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); let result: any; try { result = JSON.parse(text); } catch { result = text; }
    return { status: response.status, body: result };
  };
  assert.match((await api('/version')).body.version, /^16\.0\.3(?:\+|$)/);
  const sourceList = (await command([...compose, 'admin', 'auth', 'list'])).stdout;
  const sourceId = Number(sourceList.split('\n').find(line => line.includes('TowerNative'))?.trim().split(/\s+/)[0]);
  assert(sourceId > 0);
  const prelinked = await api('/admin/users', 'POST', { username: `preserved-${suffix}`, email: `${existing.id}@users.tower.invalid`, source_id: sourceId, login_name: existing.id, must_change_password: false });
  assert.equal(prelinked.status, 201);

  process.env.WINGMAN_FORGEJO_SERVERS = JSON.stringify([{ origin: forgejoUrl, towerIssuer: config.git.oidcIssuer, sourceName: 'TowerNative', clientId: 'a4792ccc-144e-407e-86c9-5e7d8d9c3269', redirectUri: 'http://127.0.0.1/' }]);
  const workspaceId = randomUUID();
  const snapshots = accounts.map(account => ({ id: account.sessionId, agent: 'codex', port: 0, status: 'running', startedAt: new Date().toISOString(), npub: existing.npub, metadata: { agentChatBotNpub: account.npub }, command: [], workingDirectory: directory, logs: [] }));
  const keyRecord = (npub: string) => { const account = accounts.find(a => a.npub === npub); return account ? { id: account.id, userNpub: existing.npub, botNpub: account.npub, botPubkeyHex: account.pubkey, isActive: 1 } : null; };
  let brokerCalls = 0;
  const credentialBroker = new TowerGitCredentialBroker({ servers: JSON.parse(process.env.WINGMAN_FORGEJO_SERVERS!) });
  const broker = new CapabilityBroker({
    botKeyStore: { getActiveKeyForUser: () => keyRecord(fresh.npub), getActiveKeyForBotNpub: keyRecord },
    keyVault: { withKey: async (record: any, operation: any) => operation(new Uint8Array(accounts.find(account => account.npub === record.botNpub)!.key)) },
    getSession: (id: string) => snapshots.find(snapshot => snapshot.id === id) ?? null,
    gitCredential: credentialBroker, audit: () => {},
  });
  const brokerServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url); if (url.pathname.endsWith('/git-credential')) brokerCalls++;
    return await broker.handle(request, url, request.method) ?? new Response('', { status: 404 });
  } }); servers.push(brokerServer);
  const brokerUrl = `http://127.0.0.1:${brokerServer.port}`;
  const envFor = (account: typeof fresh) => {
    const capability = broker.issueSessionCapability({ sessionId: account.sessionId, ownerNpub: existing.npub, botNpub: account.npub, workspaceId, policy: buildDefaultAgentCapabilityPolicy({ towerUrl: 'https://dev.otherstuff.studio:33110', autopilotUrl: brokerUrl }) });
    return { ...process.env, WINGMAN_BROKER_URL: brokerUrl, WINGMAN_URL: brokerUrl, SESSION_ID: account.sessionId, WINGMAN_CAPABILITY: capability.token,
      PATH: `${directory}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSL_CAINFO: '/tmp/tower-native-forgejo/cert.pem',
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: `credential.${forgejoUrl}.helper`, GIT_CONFIG_VALUE_1: 'wingman', GIT_CONFIG_KEY_2: `credential.${forgejoUrl}.useHttpPath`, GIT_CONFIG_VALUE_2: 'true' };
  };
  const environments = new Map(accounts.map(account => [account.name, envFor(account)]));
  await command(['bun', 'build', '--compile', '--minify', 'src/git/git-credential-wingman.ts', '--outfile', join(directory, 'git-credential-wingman')], process.env, autopilot);
  const credential = async (account: typeof fresh, allowFailure = false) => {
    const child = Bun.spawn([join(directory, 'git-credential-wingman'), 'get'], { env: environments.get(account.name), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write('protocol=https\nhost=dev.otherstuff.studio:33310\npath=fixture/native.git\n\n'); child.stdin.end();
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (status && !allowFailure) throw new Error(`Helper failed: ${error}`);
    return { status, error, username: output.split('\n').find(line => line.startsWith('username='))?.slice(9), password: output.split('\n').find(line => line.startsWith('password='))?.slice(9) };
  };
  const native = await credential(fresh); assert(native.password); assert(native.username);
  const who = await api('/user', 'GET', undefined, native.password); assert.equal(who.status, 200); assert.equal(who.body.is_admin, false);
  evidence.firstRegistration = { username: who.body.login, isAdmin: who.body.is_admin, nativeId: who.body.id };
  const existingCredential = await credential(existing); assert(existingCredential.password);
  const existingUser = await api('/user', 'GET', undefined, existingCredential.password);
  assert.equal(existingUser.body.id, prelinked.body.id);
  assert.equal(existingUser.body.login, `preserved-${suffix}`);
  const users = await api('/admin/users?limit=1000');
  assert.equal(users.body.find((user: any) => user.id === existingUser.body.id).login_name, existing.id);
  evidence.existingSubject = existing.id;
  const denied = await credential(unlisted, true); assert.notEqual(denied.status, 0); evidence.unlistedIdentity = 'denied';
  const repo = `native-${suffix}`;
  assert.equal((await api('/user/repos', 'POST', { name: repo, private: true, auto_init: true, default_branch: 'main' })).status, 201);
  const path = `/repos/${adminName}/${repo}`;
  assert.equal((await api(`${path}/collaborators/${native.username}`, 'PUT', { permission: 'write' })).status, 204);
  const remote = `${forgejoUrl}/${adminName}/${repo}.git`, checkout = join(directory, 'checkout');
  const env = environments.get('fresh');
  await command(['git', 'clone', remote, checkout], env);
  await command(['git', '-C', checkout, 'fetch', 'origin'], env);
  await command(['git', '-C', checkout, 'checkout', '-b', 'work/native'], env);
  await command(['git', '-C', checkout, '-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'test: native helper'], env);
  await command(['git', '-C', checkout, 'push', 'origin', 'HEAD:refs/heads/work/native'], env);
  evidence.directGit = 'clone/fetch/disposable branch push passed';
  let token = (await credential(fresh)).password!;
  assert.equal((await api(`${path}/issues`, 'POST', { title: 'Native OAuth issue' }, token)).status, 201);
  assert.equal((await api(`${path}/pulls`, 'POST', { title: 'Native OAuth PR', head: 'work/native', base: 'main' }, token)).status, 201);
  evidence.directApi = 'issue and PR creation passed';
  const cli = await command(['bun', join(autopilot, 'clis/wingman.ts'), 'forgejo', 'issues', 'create', '--forgejo-url', forgejoUrl, '--repo', `${adminName}/${repo}`, '--title', 'Shipped CLI native issue', '--body', 'Direct native OAuth API'], env);
  const cliIssue = JSON.parse(cli.stdout);
  assert(cliIssue, 'CLI must return native issue JSON');
  evidence.shippedCli = 'wingman forgejo issues create passed';
  assert.notEqual((await api(path, 'GET', undefined, existingCredential.password)).status, 200);
  evidence.foreignAccountToken = 'valid native OAuth token without repository access denied';

  const protectedResult = await api(`${path}/branch_protections`, 'POST', { branch_name: 'main', rule_name: 'main', enable_push: false });
  assert.equal(protectedResult.status, 201);
  assert.notEqual((await command(['git', '-C', checkout, 'push', 'origin', 'HEAD:refs/heads/main'], env, undefined, true)).status, 0);
  evidence.branchProtection = 'main push denied';
  // Native team grants are independent of direct collaborators and Tower state.
  const org = `team-org-${suffix}`;
  assert.equal((await api('/orgs', 'POST', { username: org, visibility: 'private' })).status, 201);
  const teamRepo = await api(`/orgs/${org}/repos`, 'POST', { name: 'team-only', private: true, auto_init: true, default_branch: 'main' });
  assert.equal(teamRepo.status, 201);
  const team = await api(`/orgs/${org}/teams`, 'POST', { name: 'native-writers', permission: 'write', units: ['repo.code', 'repo.issues'] });
  assert.equal(team.status, 201);
  const teamPath = `/teams/${team.body.id}`;
  assert.equal((await api(`${teamPath}/repos/${org}/team-only`, 'PUT')).status, 204);
  const teamRemote = `${forgejoUrl}/${org}/team-only.git`;
  const teamCheckout = join(directory, 'team-checkout');

  const beforeRelogin = completions;
  await new Promise(resolve => setTimeout(resolve, 16_000));
  assert.equal((await api('/user', 'GET', undefined, token)).status, 401);
  token = (await credential(fresh)).password!;
  assert(completions > beforeRelogin); assert.equal((await api('/user', 'GET', undefined, token)).status, 200);
  evidence.expiry = '15s native access token expires; helper repeats signed Tower login';
  const sameTokenProbe = async () => fetch(`${remote}/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${Buffer.from(`${native.username}:${token}`).toString('base64')}` } });
  assert.equal((await api(`${path}/collaborators/${native.username}`, 'PUT', { permission: 'read' })).status, 204);
  const loginCount = completions;
  assert.equal((await credential(fresh)).password, token, 'Native permission downgrade must retain the exact issued token');
  assert.equal((await sameTokenProbe()).status, 200);
  assert.notEqual((await command(['git', '-C', checkout, 'push', 'origin', 'HEAD:refs/heads/work/read-denied'], env, undefined, true)).status, 0);
  assert.equal(completions, loginCount, 'Permission denial must not trigger a new login');
  assert.equal((await api(`${path}/collaborators/${native.username}`, 'DELETE')).status, 204);
  assert.notEqual((await sameTokenProbe()).status, 200);
  assert.notEqual((await command(['git', '-C', checkout, 'fetch', 'origin'], env, undefined, true)).status, 0);
  assert.equal((await credential(fresh)).password, token, 'Read removal must retain the exact issued token');
  assert.notEqual((await command(['git', 'clone', remote, join(directory, 'removed-clone')], env, undefined, true)).status, 0);
  assert.equal(completions, loginCount, 'Native read removal must not trigger a new login');
  evidence.nativePermissionChanges = 'same OAuth token: Write→Read denies push; removal denies clone/fetch/read';
  assert.equal((await api('/user', 'GET', undefined, token)).status, 200);
  assert.notEqual((await api(`/repos/${org}/team-only`, 'GET', undefined, token)).status, 200);
  assert.equal((await api(`${teamPath}/members/${native.username}`, 'PUT')).status, 204);
  assert.equal((await credential(fresh)).password, token, 'Team addition must retain the exact issued token');
  await command(['git', 'clone', teamRemote, teamCheckout], env);
  await command(['git', '-C', teamCheckout, '-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'test: native team helper'], env);
  await command(['git', '-C', teamCheckout, 'push', 'origin', 'HEAD:refs/heads/work/team-write'], env);
  assert.equal((await api(teamPath, 'PATCH', { name: 'native-writers', permission: 'read', units: ['repo.code', 'repo.issues'] })).status, 200);
  await command(['git', '-C', teamCheckout, 'fetch', 'origin'], env);
  assert.notEqual((await command(['git', '-C', teamCheckout, 'push', 'origin', 'HEAD:refs/heads/work/team-read-denied'], env, undefined, true)).status, 0);
  assert.equal((await credential(fresh)).password, token, 'Team downgrade must retain the exact issued token');
  assert.equal((await api(`${teamPath}/members/${native.username}`, 'DELETE')).status, 204);
  assert.notEqual((await command(['git', '-C', teamCheckout, 'fetch', 'origin'], env, undefined, true)).status, 0);
  assert.notEqual((await command(['git', 'clone', teamRemote, join(directory, 'team-removed-clone')], env, undefined, true)).status, 0);
  assert.notEqual((await api(`/repos/${org}/team-only`, 'GET', undefined, token)).status, 200);
  assert.equal((await credential(fresh)).password, token, 'Team member removal must retain the exact issued token');
  assert.equal(completions, loginCount, 'Native team changes must not trigger a Tower sign-in');
  evidence.nativeTeamPermissionChanges = 'same OAuth token: team addition enables clone/push; Write→Read keeps fetch and denies push; member removal denies clone/fetch/API read; no Tower state change or sign-in';

  assert.equal((await api(`${path}/collaborators/${native.username}`, 'PUT', { permission: 'write' })).status, 204);
  token = (await credential(fresh)).password!;
  towerAvailable = false;
  assert.equal((await api('/user', 'GET', undefined, token)).status, 200);
  await command(['git', '-C', checkout, 'fetch', 'origin'], env);
  assert.equal((await api(`${path}/issues`, 'POST', { title: 'Tower offline issue' }, token)).status, 201);
  assert.equal((await api('/user', 'GET', undefined, 'invalid-foreign-token')).status, 401);
  evidence.towerDowntime = 'valid native token works for Git fetch and API writes';
  evidence.invalidToken = '401';
  towerAvailable = true;
  config.git.oidcAllowedNpubs = [existing.npub];
  assert.equal((await api('/user', 'GET', undefined, token)).status, 200);
  const beforeRemoval = completions;
  await new Promise(resolve => setTimeout(resolve, 16_000));
  const removed = await credential(fresh, true);
  assert.notEqual(removed.status, 0);
  assert.equal(completions, beforeRemoval + 1, 'Allowlist denial must be one bounded sign-in attempt');
  evidence.allowlistRemoval = 'valid native token remains valid; expired token re-login denied once';

  evidence.brokerCalls = brokerCalls;
  evidence.nostrCompletions = completions;
  evidence.passed = true;
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const server of servers.reverse()) server.stop(true);
  await sql.end(); await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.end();
  await rm(directory, { recursive: true, force: true });
}
