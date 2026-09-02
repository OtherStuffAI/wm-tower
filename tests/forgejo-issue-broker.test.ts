import { describe, expect, test } from 'bun:test';
import { createIssueBrokerApp } from '../src/forgejo/issue-broker';

const brokerToken = 'issue-broker-test-token-000000000000';
const repository = {
  forgejo_owner: 'wm-test',
  forgejo_repository: 'wmapp',
  actor_username: 'workspace-member',
  actor_display_name: 'Workspace Member',
};

function providerIssue(number = 7) {
  return {
    number,
    title: 'Offline signing',
    body: 'Add NIP-55 support.',
    state: 'open',
    html_url: `https://forgejo.example/wm-test/wmapp/issues/${number}`,
    user: { login: 'workspace-member', full_name: 'Workspace Member' },
    labels: [{ name: 'enhancement', color: '00aa00' }],
    comments: 2,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:01:00Z',
    closed_at: null,
  };
}

describe('isolated Forgejo issue broker', () => {
  test('rejects callers without the dedicated broker token', async () => {
    const app = createIssueBrokerApp({
      forgejoUrl: 'http://forgejo.internal',
      brokerToken,
      fetchImpl: (async () => Response.json(providerIssue())) as unknown as typeof fetch,
    });
    const response = await app.request('/v1/issues/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...repository, state: 'open', page: 1, limit: 30 }),
    });
    expect(response.status).toBe(401);
  });

  test('creates issues as the Tower actor through trusted reverse-proxy auth', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: any }> = [];
    const app = createIssueBrokerApp({
      forgejoUrl: 'http://forgejo.internal',
      brokerToken,
      fetchImpl: (async (input: string | URL | Request, init: RequestInit = {}) => {
        calls.push({
          url: String(input), method: init.method || 'GET', headers: new Headers(init.headers),
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json(providerIssue(), { status: 201 });
      }) as typeof fetch,
    });
    const response = await app.request('/v1/issues/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wingman-issue-broker-token': brokerToken },
      body: JSON.stringify({ ...repository, title: 'Offline signing', body: 'Add NIP-55 support.' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      issue: { issue_number: 7, author: { username: 'workspace-member', display_name: 'Workspace Member' } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith('/api/v1/repos/wm-test/wmapp/issues');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('x-webauth-user')).toBe('workspace-member');
    expect(calls[0].headers.get('x-webauth-fullname')).toBe('Workspace Member');
    expect(calls[0].headers.get('authorization')).toBeNull();
    expect(calls[0].body).toEqual({ title: 'Offline signing', body: 'Add NIP-55 support.' });
  });

  test('lists only issues, not pull requests, with bounded pagination', async () => {
    let requestedUrl = '';
    const app = createIssueBrokerApp({
      forgejoUrl: 'http://forgejo.internal',
      brokerToken,
      fetchImpl: (async (input: string | URL | Request) => {
        requestedUrl = String(input);
        return Response.json([providerIssue()]);
      }) as typeof fetch,
    });
    const response = await app.request('/v1/issues/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wingman-issue-broker-token': brokerToken },
      body: JSON.stringify({ ...repository, state: 'all', page: 2, limit: 25 }),
    });
    expect(response.status).toBe(200);
    expect(requestedUrl).toContain('state=all&type=issues&page=2&limit=25');
    expect((await response.json() as any).issues).toHaveLength(1);
  });
});
