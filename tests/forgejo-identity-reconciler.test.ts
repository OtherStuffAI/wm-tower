import { describe, expect, test } from 'bun:test';
import { reconcileForgejoActorAliases } from '../src/forgejo/reconcile-identities';

const options = { towerUrl: 'http://tower', forgejoUrl: 'http://forgejo', internalToken: 'i'.repeat(40), identityToken: 'a'.repeat(40), sourceId: 7 };
function fixture(input: { users?: any[]; bindings?: any[]; createStatus?: number; sourceId?: number; loseCreateResponse?: boolean; pageSize?: number } = {}) {
  const users = input.users ?? [];
  const bindings = input.bindings ?? [{ actor_id: 'actor-1', current_username: 'wm-old', desired_username: 'agent-one', state: 'pending', forgejo_user_id: null }];
  let lostResponse = false;
  const calls: { path: string; body: any }[] = [];
  const fetchImpl = (async (url: any, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    if (path.endsWith('/actor-bindings')) return Response.json({ actor_bindings: bindings });
    if (path === '/api/v1/admin/users' && !body) {
      const page = Number(new URL(String(url)).searchParams.get('page'));
      const size = input.pageSize ?? 100;
      return Response.json(users.slice((page - 1) * size, page * size));
    }
    if (path === '/api/v1/admin/users') {
      if (input.createStatus) return new Response('', { status: input.createStatus });
      if (users.some(user => user.email === body.email || user.username === body.username)) return new Response('', { status: 422 });
      const user = { id: users.length + 1, ...body }; users.push(user);
      if (input.loseCreateResponse && !lostResponse) { lostResponse = true; throw new Error('lost response with private provider details'); }
      return Response.json(user, { status: 201 });
    }
    if (path.endsWith('/rename')) {
      const name = decodeURIComponent(path.split('/').at(-2)!);
      if (typeof body.new_username !== 'string' || !body.new_username) return Response.json({ message: 'new_username required' }, { status: 422 });
      users.find(user => user.username === name).username = body.new_username;
      return new Response(null, { status: 204 });
    }
    if (path.includes('/actor-bindings/') && body) {
      const binding = bindings.find(b => path.endsWith(b.actor_id));
      Object.assign(binding, { forgejo_user_id: body.forgejo_user_id, current_username: body.username, desired_username: body.username, state: 'ready' });
    }
    return Response.json({});
  }) as typeof fetch;
  return { users, bindings, calls, run: () => reconcileForgejoActorAliases({ ...options, sourceId: input.sourceId ?? options.sourceId, fetchImpl }) };
}

describe('Forgejo actor identity reconciler', () => {
  test('creates a headless external account and repeat bootstrap keeps one immutable binding', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ processed: 1, linked: 1, failed: 0 });
    expect(f.users).toHaveLength(1);
    expect(f.users[0]).toMatchObject({ source_id: 7, login_name: 'actor-1', email: 'actor-1@users.tower.invalid', username: 'agent-one', must_change_password: false });
    expect(f.users[0].password).toBeUndefined();
    expect(await f.run()).toEqual({ processed: 1, linked: 0, failed: 0 });
    expect(f.users).toHaveLength(1);
  });
  test('finds existing OIDC accounts beyond the first page without duplicate creation', async () => {
    const users = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, username: `other-${i}` }));
    users.push({ id: 200, username: 'old-name', source_id: 7, login_name: 'actor-1' } as any);
    const f = fixture({ users, pageSize: 25 });
    expect((await f.run()).linked).toBe(1);
    expect(users).toHaveLength(101);
    expect(f.bindings[0].forgejo_user_id).toBe(200);
    expect(users[100].username).toBe('agent-one');
  });
  test('does not hijack matching usernames or subjects from a foreign provider', async () => {
    const f = fixture({ users: [{ id: 1, username: 'agent-one', login_name: 'actor-1', source_id: 9 }], createStatus: 422 });
    expect((await f.run()).failed).toBe(1);
    expect(f.bindings[0].forgejo_user_id).toBeNull();
    expect(f.calls.at(-1)?.body.error_code).toBe('git_actor_username_conflict');
  });
  test('follows established immutable IDs across provider renames including legacy accounts', async () => {
    const f = fixture({ bindings: [{ actor_id: 'actor-1', desired_username: 'before', current_username: 'before', forgejo_user_id: 42, state: 'ready' }], users: [{ id: 42, username: 'after', source_id: 0 }] });
    expect((await f.run()).linked).toBe(1);
    expect(f.bindings[0].current_username).toBe('after');
    expect(f.calls.some(c => c.path.endsWith('/rename'))).toBeFalse();
  });
  test('a deleted linked account requires repair instead of silently creating a replacement', async () => {
    const f = fixture({ bindings: [{ actor_id: 'actor-1', desired_username: 'before', current_username: 'before', forgejo_user_id: 42, state: 'ready' }] });
    expect((await f.run()).failed).toBe(1);
    expect(f.users).toHaveLength(0);
    expect(f.calls.at(-1)?.body.error_code).toBe('git_forgejo_actor_binding_missing');
  });
  test('unconfigured OIDC source becomes an observable safe error', async () => {
    const f = fixture({ sourceId: 0 });
    expect((await f.run()).failed).toBe(1);
    expect(f.calls.at(-1)?.body.error_code).toBe('git_forgejo_oidc_source_unconfigured');
    expect(f.users).toHaveLength(0);
  });
});


test('lost create response is recovered by source and subject without duplicate creation', async () => {
  const f = fixture({ loseCreateResponse: true });
  expect((await f.run()).failed).toBe(1);
  expect(f.calls.at(-1)?.body.error_code).toBe('git_forgejo_identity_unavailable');
  expect((await f.run()).linked).toBe(1);
  expect(f.users).toHaveLength(1);
});

test('concurrent create retries converge on one source/subject account', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run()]);
  await f.run();
  expect(f.users).toHaveLength(1);
  expect(f.bindings[0].forgejo_user_id).toBe(f.users[0].id);
});
