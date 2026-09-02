import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { ForgejoClient } from '../src/forgejo/client';
import type { GitForgejoDesiredState } from '../src/types';

const state: GitForgejoDesiredState = {
  repository_id: '22222222-2222-4222-8222-222222222222',
  workspace_id: '11111111-1111-4111-8111-111111111111',
  forgejo_owner: 'otherstuff',
  forgejo_repository: 'kindling',
  desired_policy_revision: 3, applied_policy_revision: null, state: 'pending', reconciled_at: null,
  display_name: 'Test', description: 'Private repository', private: true, default_branch: 'main',
  actor_access: [
    { actor_id: '33333333-3333-4333-8333-333333333333', shadow_username: 'workspace-member', display_name: 'Workspace Member', permission: 'write', organization_role: 'member' },
    { actor_id: '66666666-6666-4666-8666-666666666666', shadow_username: 'workspace-owner', display_name: 'Workspace Owner', permission: 'admin', organization_role: 'owner' },
  ],
  branch_rules: ['main', 'staging', 'deployed'].map((name, index) => ({
    policy_id: `44444444-4444-4444-8444-44444444444${index}`,
    ref_name: `refs/heads/${name}`, branch_class: name as 'main' | 'staging' | 'deployed',
    protected: true, service_managed: true, allow_direct_push: false, allow_force_push: false,
    allow_delete: false, required_approvals: name === 'main' ? 1 : 0, required_checks: [], merge_methods: ['squash'],
  })).concat(['work/', 'feature/'].map((name, index) => ({
    policy_id: `55555555-5555-4555-8555-55555555555${index}`,
    ref_name: `refs/heads/${name}`, branch_class: 'work' as const,
    protected: false, service_managed: false, allow_direct_push: true, allow_force_push: false,
    allow_delete: false, required_approvals: 0, required_checks: [], merge_methods: ['squash'] as Array<'squash'>,
  }))),
};

describe('Forgejo control-plane adapter', () => {
  test('provisions only private Tower-bound state and replicates protected branches', async () => {
    const calls: Array<{ url: string; method: string; body?: any; auth: string | null; shadow: string | null; fullName: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body, auth: headers.get('authorization'), shadow: headers.get('x-webauth-user'), fullName: headers.get('x-webauth-fullname') });
      if (url.endsWith(`/api/v1/orgs/${state.forgejo_owner}`)) return new Response('', { status: 404 });
      if (url.endsWith(`/api/v1/repos/${state.forgejo_owner}/${state.forgejo_repository}`)) return new Response('', { status: 404 });
      if (url.endsWith(`/api/v1/orgs/${state.forgejo_owner}/teams?limit=100`)) return Response.json([{ id: 1, name: 'Owners', permission: 'owner' }]);
      if (url.includes('/api/v1/teams/') && url.endsWith('/members?limit=1000')) return Response.json([]);
      if (url.endsWith(`/api/v1/orgs/${state.forgejo_owner}/teams`) && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'tower-members' });
        return Response.json({ id: 2, name: 'tower-members', permission: 'read' }, { status: 201 });
      }
      if (url.includes('/branch_protections/')) return new Response('', { status: 404 });
      if (url.endsWith('/')) return new Response('', { status: 302 });
      if (method === 'DELETE') return new Response('', { status: 204 });
      return Response.json({}, { status: method === 'PUT' ? 204 : 201 });
    }) as typeof fetch;
    await new ForgejoClient({ baseUrl: 'http://forgejo.internal', controlToken: randomBytes(32).toString('base64url'), fetchImpl }).reconcile(state);
    const repoCreate = calls.find((call) => call.url.endsWith(`/orgs/${state.forgejo_owner}/repos`) && call.method === 'POST');
    expect(repoCreate?.body).toMatchObject({ name: state.forgejo_repository, private: true, default_branch: 'main' });
    expect(calls.filter((call) => call.url.endsWith('/branch_protections') && call.method === 'POST')).toHaveLength(5);
    for (const protection of calls.filter((call) => call.url.endsWith('/branch_protections') && call.method === 'POST')) {
      expect(protection.body).toMatchObject({ enable_force_push: false, enable_deletion: false });
    }
    expect(calls.some((call) => call.shadow !== null)).toBeFalse();
    expect(calls.some((call) => call.url.endsWith(`/teams/2/members/${state.actor_access[0].shadow_username}`) && call.method === 'PUT')).toBeTrue();
    expect(calls.some((call) => call.url.endsWith(`/teams/1/members/${state.actor_access[1].shadow_username}`) && call.method === 'PUT')).toBeTrue();
    expect(calls.some((call) => call.body?.admin === true || call.body?.site_admin === true)).toBeFalse();
  });
});
