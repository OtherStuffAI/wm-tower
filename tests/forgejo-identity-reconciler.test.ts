import { describe, expect, test } from 'bun:test';
import { reconcileForgejoActorAliases } from '../src/forgejo/reconcile-identities';

const options = { towerUrl: 'http://tower', forgejoUrl: 'http://forgejo', internalToken: 'i'.repeat(40), identityToken: 'a'.repeat(40) };

describe('Forgejo actor identity reconciler', () => {
  test('links and follows a renamed provider account by immutable OIDC subject', async () => {
    const syncs: any[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/actor-bindings')) return Response.json({ actor_bindings: [{ actor_id: 'actor-1', current_username: 'old-name', forgejo_user_id: 42 }] });
      if (url.includes('/api/v1/admin/users?')) {
        expect(url).toContain('limit=1000');
        expect(new Headers(init?.headers).get('authorization')).toBe(`token ${options.identityToken}`);
        return Response.json([{ id: 42, login_name: 'actor-1', username: 'new-name' }]);
      }
      if (url.endsWith('/actor-bindings/actor-1')) { syncs.push(JSON.parse(String(init?.body))); return Response.json({}); }
      return new Response('', { status: 500 });
    };
    expect(await reconcileForgejoActorAliases({ ...options, fetchImpl: fetchImpl as typeof fetch })).toEqual({ processed: 1, linked: 1, failed: 0 });
    expect(syncs).toEqual([{ forgejo_user_id: 42, username: 'new-name' }]);
  });

  test('leaves actors unbound until their first OIDC login', async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/actor-bindings')) return Response.json({ actor_bindings: [{ actor_id: 'actor-2', current_username: 'wm-new', forgejo_user_id: null }] });
      if (url.includes('/api/v1/admin/users?')) return Response.json([]);
      return new Response('', { status: 500 });
    };
    expect(await reconcileForgejoActorAliases({ ...options, fetchImpl: fetchImpl as typeof fetch })).toEqual({ processed: 1, linked: 0, failed: 0 });
  });

  test('does not rewrite an unchanged stable binding', async () => {
    let posts = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/actor-bindings')) return Response.json({ actor_bindings: [{ actor_id: 'actor-3', current_username: 'rick', forgejo_user_id: 7 }] });
      if (url.includes('/api/v1/admin/users?')) return Response.json([{ id: 7, login_name: 'legacy-login', username: 'rick' }]);
      if (init?.method === 'POST') posts += 1;
      return new Response('', { status: 500 });
    };
    expect(await reconcileForgejoActorAliases({ ...options, fetchImpl: fetchImpl as typeof fetch })).toEqual({ processed: 1, linked: 0, failed: 0 });
    expect(posts).toBe(0);
  });
});
