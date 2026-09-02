import { describe, expect, test } from 'bun:test';
import { reconcilePendingForgejoOrganizations } from '../src/forgejo/reconcile-organizations';

describe('Forgejo workspace organization reconciler', () => {
  test('projects pending Tower organizations and acknowledges the exact provider name', async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.endsWith('/internal/forgejo/organizations/pending')) {
        return Response.json({ organizations: [{ workspace_id: workspaceId, forgejo_owner: 'other-stuff', state: 'pending', reconciled_at: null }] });
      }
      if (url.endsWith(`/internal/forgejo/organizations/${workspaceId}/desired-state`)) {
        return Response.json({
          workspace_id: workspaceId, forgejo_owner: 'other-stuff', state: 'pending', reconciled_at: null,
          display_name: 'Other Stuff', actor_access: [], managed_usernames: [],
        });
      }
      if (url.endsWith(`/internal/forgejo/organizations/${workspaceId}/ack`)) return Response.json({ ok: true });
      if (url.endsWith('/api/v1/orgs/other-stuff')) return new Response('', { status: 404 });
      if (url.endsWith('/api/v1/orgs') && method === 'POST') return Response.json({ username: 'other-stuff' }, { status: 201 });
      if (url.endsWith('/api/v1/orgs/other-stuff/teams?limit=100')) return Response.json([{ id: 1, name: 'Owners', permission: 'owner' }]);
      if (url.endsWith('/api/v1/teams/1/members?limit=1000')) return Response.json([]);
      return new Response('', { status: 500 });
    }) as typeof fetch;

    const result = await reconcilePendingForgejoOrganizations({
      towerUrl: 'http://tower.internal', forgejoUrl: 'http://forgejo.internal',
      internalToken: 'i'.repeat(32), controlToken: 'c'.repeat(32), fetchImpl,
    });
    expect(result).toEqual({ processed: 1, reconciled: 1, failed: 0 });
    expect(calls).toContainEqual(expect.objectContaining({
      url: `http://tower.internal/api/v4/git/internal/forgejo/organizations/${workspaceId}/ack`,
      method: 'POST', body: { forgejo_owner: 'other-stuff', ok: true },
    }));
  });
});
