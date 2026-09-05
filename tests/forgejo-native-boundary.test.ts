import { describe, expect, test } from 'bun:test';
import { createForgejoGateway } from '../src/forgejo/gateway';
import { createApp } from '../src/server';
import { buildOpenApiDocument } from '../src/openapi';

describe('native Forgejo boundary', () => {
  test('retires every public and private Tower Git authority path', async () => {
    const app = createApp();
    for (const path of ['repositories', 'credential-exchanges', 'internal/forgejo/organizations/pending', 'internal/forgejo/actor-bindings', 'internal/capabilities/introspect']) {
      for (const method of ['GET', 'POST']) expect((await app.request(`/api/v4/git/${path}`, { method })).status).toBe(410);
    }
    const paths = Object.keys(buildOpenApiDocument('https://tower.test').paths).filter(p => p.startsWith('/api/v4/git/'));
    expect(paths.every(p => p.startsWith('/api/v4/git/oidc/'))).toBe(true);
  });

  test('passes native APIs, sharing, Git and redirects without contacting Tower', async () => {
    const calls: string[] = [];
    const app = createForgejoGateway({ forgejoUrl: 'http://provider:3000', fetchImpl: (async (url: URL, init: RequestInit) => {
      calls.push(url.toString());
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer native-fixture-token');
      expect(headers.get('cookie')).toBe('session=native');
      expect(headers.get('x-webauth-user')).toBeNull();
      expect(init.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://foreign.test/', 'set-cookie': 'session=next; Secure; HttpOnly' } });
    }) as typeof fetch });
    for (const path of ['/api/v1/repos/team/repo/issues', '/team/repo/settings/collaboration', '/team/repo.git/info/refs?service=git-upload-pack']) {
      const response = await app.request(`https://forgejo.test${path}`, { headers: { authorization: 'Bearer native-fixture-token', cookie: 'session=native', 'x-webauth-user': 'admin' } });
      expect(response.status).toBe(302);
      expect(response.headers.get('set-cookie')).toContain('session=next');
    }
    expect(calls).toHaveLength(3);
    expect(calls.every(url => url.startsWith('http://provider:3000/'))).toBe(true);
  });

  test('old worker commands fail before any network access', async () => {
    for (const worker of ['reconcile', 'reconcile-organizations', 'reconcile-identities', 'issue-broker']) {
      const result = Bun.spawnSync(['bun', `src/forgejo/${worker}.ts`], { stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain('Retired: Forgejo owns');
    }
  });
});
