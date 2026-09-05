import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createForgejoGateway } from '../src/forgejo/gateway';
import { forgejoShadowUsername } from '../src/forgejo/identity';

const serviceToken = 's'.repeat(40);
const capability = randomBytes(32).toString('base64url');
const workspaceId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const owner = 'otherstuff';
const repository = 'kindling';

function basic(password = capability, username = 'nostr') {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

describe('Forgejo smart-HTTP gateway', () => {
  test('challenges an unauthenticated Git probe and accepts its Basic credential retry', async () => {
    let upstreamRequests = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/resolve')) return Response.json({ repository_id: repositoryId, ready: true });
      if (url.includes('/introspect')) {
        expect(await new Response(init?.body).json()).toMatchObject({ capability });
        return Response.json({ active: true, actor_id: actorId, reason_code: 'git_capability_active' });
      }
      upstreamRequests += 1;
      return new Response('001e# service=git-upload-pack\n0000', {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      });
    }) as typeof fetch;
    const app = createForgejoGateway({
      towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal',
      internalServiceToken: serviceToken, audience: 'wingman-git', fetchImpl,
    });
    const url = `http://gateway/${owner}/${repository}.git/info/refs?service=git-upload-pack`;

    const challenge = await app.request(url);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toBe('Basic realm="Wingman Git", charset="UTF-8"');
    expect(challenge.headers.get('www-authenticate')).not.toContain(capability);
    expect(upstreamRequests).toBe(0);

    const retry = await app.request(url, { headers: { authorization: basic() } });
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain('git-upload-pack');
    expect(upstreamRequests).toBe(1);
  });

  test('replaces client credentials and spoofable identity headers before streaming to Forgejo', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/internal/forgejo/resolve')) return Response.json({ repository_id: repositoryId, ready: true });
      if (url.endsWith('/internal/capabilities/introspect')) {
        expect(await new Response(init?.body).json()).toMatchObject({
          capability, repository_id: repositoryId, service: 'upload-pack', required_scope: 'git.fetch',
        });
        return Response.json({ active: true, reason_code: 'git_capability_active', actor_id: actorId, actor_username: 'workspace-member', actor_display_name: 'Workspace Member' });
      }
      expect(url).toBe(`http://forgejo.internal/${owner}/${repository}.git/info/refs?service=git-upload-pack`);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('x-webauth-user')).toBe('workspace-member');
      expect(headers.get('x-webauth-fullname')).toBe('Workspace Member');
      expect(headers.get('x-forwarded-user')).toBeNull();
      expect(headers.get('x-wingman-git-service-token')).toBeNull();
      return new Response('001e# service=git-upload-pack\n0000', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'set-cookie': 'provider=secret' } });
    }) as typeof fetch;
    const app = createForgejoGateway({
      towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal',
      internalServiceToken: serviceToken, audience: 'wingman-git', fetchImpl,
    });
    const response = await app.request(`http://gateway/${owner}/${repository}.git/info/refs?service=git-upload-pack`, {
      headers: {
        authorization: basic(), cookie: 'client=secret', 'x-webauth-user': 'admin',
        'x-forwarded-user': 'admin', 'x-wingman-git-service-token': 'client-controlled',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('git-upload-pack');
    expect(response.headers.get('authorization')).toBeNull();
  });

  test('fails closed for malformed paths, wrong username, stale reconciliation, inactive capability, and unavailable authority', async () => {
    let mode: 'stale' | 'inactive' | 'unavailable' = 'stale';
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (mode === 'unavailable') throw new Error('offline');
      if (url.includes('/resolve')) return Response.json({ repository_id: repositoryId, ready: mode !== 'stale' });
      return Response.json({ active: false, reason_code: 'git_capability_wrong_repository' });
    }) as typeof fetch;
    const app = createForgejoGateway({
      towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal',
      internalServiceToken: serviceToken, audience: 'wingman-git', fetchImpl,
    });
    expect((await app.request(`http://gateway/Invalid/${repository}.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic() } })).status).toBe(404);
    expect((await app.request(`http://gateway/${owner}/${repository}.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic(capability, 'admin') } })).status).toBe(401);
    expect((await app.request(`http://gateway/${owner}/${repository}.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic() } })).status).toBe(503);
    mode = 'inactive';
    expect((await app.request(`http://gateway/${owner}/${repository}.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic() } })).status).toBe(403);
    mode = 'unavailable';
    expect((await app.request(`http://gateway/${owner}/${repository}.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic() } })).status).toBe(503);
  });

  test('maps receive-pack to write introspection and never forwards the opaque capability', async () => {
    const seen: any[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/resolve')) return Response.json({ repository_id: repositoryId, ready: true });
      if (url.includes('/introspect')) {
        seen.push(await new Response(init?.body).json());
        return Response.json({ active: true, actor_id: actorId, actor_display_name: 'Workspace Member', reason_code: 'git_capability_active' });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      return new Response('0000', { status: 200 });
    }) as typeof fetch;
    const app = createForgejoGateway({
      towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal',
      internalServiceToken: serviceToken, audience: 'wingman-git', fetchImpl,
    });
    const response = await app.request(`http://gateway/${owner}/${repository}.git/git-receive-pack`, {
      method: 'POST', headers: { authorization: basic(), 'content-type': 'application/x-git-receive-pack-request' }, body: '0000',
    });
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ service: 'receive-pack', required_scope: 'git.push.unprotected' });
  });
});

describe('Forgejo browser reverse proxy', () => {
  test('leaves authentication and settings to Forgejo while stripping spoofed identity headers', async () => {
    const calls: Array<{ url: string; headers: Headers; method: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), headers: new Headers(init.headers), method: init.method || 'GET' });
      return new Response('<html>Forgejo settings</html>', { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'i_like_forgejo=session; Path=/; HttpOnly' } });
    }) as typeof fetch;
    const app = createForgejoGateway({ towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal', internalServiceToken: serviceToken, audience: 'wingman-git', browserOrigin: 'https://forgejo.example.test', fetchImpl });
    const response = await app.request('https://forgejo.example.test/user/settings', { headers: { cookie: 'i_like_forgejo=existing', authorization: 'Bearer forgejo-token', 'x-webauth-user': 'admin', 'x-forwarded-user': 'admin' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Forgejo settings');
    expect(response.headers.get('set-cookie')).toContain('i_like_forgejo=session');
    expect(calls[0].url).toBe('http://forgejo.internal/user/settings');
    expect(calls[0].headers.get('cookie')).toBe('i_like_forgejo=existing');
    expect(calls[0].headers.get('authorization')).toBe('Bearer forgejo-token');
    expect(calls[0].headers.get('x-webauth-user')).toBeNull();
    expect(calls[0].headers.get('x-forwarded-user')).toBeNull();
  });

  test('prevents stale compression metadata from breaking browser assets', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      expect(new Headers(init.headers).get('accept-encoding')).toBe('identity');
      return new Response('var loaded=true;', {
        status: 200,
        headers: {
          'content-type': 'text/javascript',
          'content-encoding': 'zstd',
          'content-length': '8',
        },
      });
    }) as typeof fetch;
    const app = createForgejoGateway({
      towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal',
      internalServiceToken: serviceToken, audience: 'wingman-git',
      browserOrigin: 'https://forgejo.example.test', fetchImpl,
    });
    const response = await app.request('https://forgejo.example.test/assets/js/index.js', {
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.text()).toBe('var loaded=true;');
  });
});

describe('Tower sharing browser bridge', () => {
  test('serves sharing at the Forgejo collaboration URL and blocks native edits and team bypasses', async () => {
    let calls = 0;
    const app = createForgejoGateway({ towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal', internalServiceToken: serviceToken,
      audience: 'git', fetchImpl: (async () => { calls++; return new Response('provider'); }) as typeof fetch });
    const response = await app.request('https://forgejo.test/otherstuff/kindling/settings/collaboration');
    expect(response.status).toBe(200); expect(await response.text()).toContain('Load sharing with Nostr');
    for (const path of ['/otherstuff/kindling/settings/collaboration', '/otherstuff/kindling/settings/collaboration/access_mode', '/org/otherstuff/teams/tower-members/action', '/otherstuff/kindling/settings/%63ollaboration', '/org/otherstuff/%74eams/tower-members/action', '/api/v1/repos/otherstuff/kindling/collaborators/lara']) {
      expect((await app.request(`https://forgejo.test${path}`, { method: 'POST' })).status).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toBe(0);
  });

  test('forwards only signed sharing intent to Tower, with gateway-owned URL headers', async () => {
    const app = createForgejoGateway({ towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal', internalServiceToken: serviceToken,
      audience: 'git', browserOrigin: 'https://forgejo.test', fetchImpl: (async (url, init) => {
        expect(String(url)).toBe('http://tower.internal/api/v4/git/forgejo/sharing/otherstuff/kindling');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Nostr signed-intent');
        expect(headers.get('cookie')).toBeNull(); expect(headers.get('x-wingman-git-service-token')).toBeNull();
        expect(headers.get('x-forwarded-host')).toBe('forgejo.test'); expect(headers.get('x-forwarded-proto')).toBe('https');
        expect(await new Response(init?.body).text()).toBe('{"access":"none"}');
        return Response.json({ policy_revision: 2 }, { status: 202 });
      }) as typeof fetch });
    const url = 'https://forgejo.test/api/v4/git/forgejo/sharing/otherstuff/kindling';
    expect((await app.request(url, { method: 'POST', headers: { cookie: 'admin=session' } })).status).toBe(401);
    expect((await app.request(url, { method: 'POST', headers: { authorization: 'Nostr signed-intent', cookie: 'admin=session',
      'x-forwarded-host': 'evil.test', 'x-wingman-git-service-token': 'spoof' }, body: '{"access":"none"}' })).status).toBe(202);
  });

  test('holds browser repository operations closed during provider reconciliation', async () => {
    let providerCalls = 0;
    const app = createForgejoGateway({ towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal', internalServiceToken: serviceToken,
      audience: 'git', fetchImpl: (async url => {
        if (String(url).includes('/resolve?')) return Response.json({ ready: false });
        providerCalls++; return new Response('provider');
      }) as typeof fetch });
    expect((await app.request('https://forgejo.test/otherstuff/kindling/src/branch/main')).status).toBe(503);
    expect((await app.request('https://forgejo.test/Otherstuff/Kindling/src/branch/main')).status).toBe(503);
    expect((await app.request('https://forgejo.test/%6ftherstuff/kindling/src/branch/main')).status).toBe(503);
    expect(providerCalls).toBe(0);
  });
});
