import { secretEnv } from '../secret-env';

type ActorBinding = { actor_id: string; current_username: string; desired_username: string; state: string; forgejo_user_id: number | null };
export type IdentityReconcilerOptions = { towerUrl: string; forgejoUrl: string; internalToken: string; identityToken: string; sourceId: number; fetchImpl?: typeof fetch };

export class IdentityReconcilerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export async function reconcileForgejoActorAliases(options: IdentityReconcilerOptions): Promise<{ processed: number; linked: number; failed: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tower = async (path: string, body?: unknown) => {
    const response = await fetchImpl(`${options.towerUrl}/api/v4/git/internal/forgejo${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'x-wingman-git-service-token': options.internalToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new IdentityReconcilerError('git_actor_binding_sync_failed', `Tower identity request failed (${response.status})`);
    return response.json() as Promise<any>;
  };
  const provider = (path: string, body?: unknown) => fetchImpl(`${options.forgejoUrl}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `token ${options.identityToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const listUsers = async () => {
    const users: any[] = [];
    for (let page = 1; ; page++) {
      const response = await provider(`/admin/users?limit=100&page=${page}`);
      if (!response.ok) throw new IdentityReconcilerError('git_forgejo_actor_lookup_failed', `Forgejo account lookup failed (${response.status})`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new IdentityReconcilerError('git_forgejo_actor_lookup_invalid', 'Invalid account list');
      users.push(...batch);
      if (batch.length === 0) return users; // Providers may clamp the requested page size.
    }
  };
  const { actor_bindings: bindings } = await tower('/actor-bindings') as { actor_bindings: ActorBinding[] };
  let linked = 0, failed = 0;
  let users: any[] | undefined;
  for (const binding of bindings) {
    try {
      if (!Number.isSafeInteger(options.sourceId) || options.sourceId <= 0) {
        throw new IdentityReconcilerError('git_forgejo_oidc_source_unconfigured', 'Configure the Tower OIDC source ID in the isolated identity worker');
      }
      const match = (users: any[]) => {
        const matches = users.filter((user) => binding.forgejo_user_id !== null
          ? Number(user.id) === binding.forgejo_user_id
          : Number(user.source_id) === options.sourceId && user.login_name === binding.actor_id);
        if (matches.length > 1) throw new IdentityReconcilerError('git_forgejo_actor_binding_conflict', 'Multiple provider accounts match the immutable identity');
        return matches[0];
      };
      users ??= await listUsers();
      let user = match(users);
      if (!user && binding.forgejo_user_id !== null) {
        throw new IdentityReconcilerError('git_forgejo_actor_binding_missing', 'The linked provider account is missing; operator repair is required');
      }
      if (!user) {
        // Forgejo enforces unique email and username. The immutable actor email
        // prevents duplicate creation even when concurrent requests choose different names.
        // Never adopt an account based on a mutable username or email alone.
        const response = await provider('/admin/users', {
          username: binding.desired_username, source_id: options.sourceId, login_name: binding.actor_id,
          email: `${binding.actor_id}@users.tower.invalid`, must_change_password: false, send_notify: false,
          visibility: 'private',
        });
        if (response.ok) { user = await response.json(); users.push(user); }
        else if (response.status === 409 || response.status === 422) { users = await listUsers(); user = match(users); }
        else throw new IdentityReconcilerError('git_forgejo_actor_create_failed', `Forgejo account creation failed (${response.status})`);
        if (!user) throw new IdentityReconcilerError('git_actor_username_conflict', 'Provider username or actor email is already held by a different identity');
        if (Number(user.source_id) !== options.sourceId || user.login_name !== binding.actor_id) {
          throw new IdentityReconcilerError('git_forgejo_actor_binding_conflict', 'Provider did not preserve the immutable identity');
        }
      }
      let username = String(user.username || user.login || '');
      if (!Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0 || !username) {
        throw new IdentityReconcilerError('git_forgejo_actor_lookup_invalid', 'Invalid external account');
      }
      if (binding.state !== 'ready' && username !== binding.desired_username) {
        const response = await provider(`/admin/users/${encodeURIComponent(username)}/rename`, { new_username: binding.desired_username });
        if (!response.ok) throw new IdentityReconcilerError(response.status === 422 || response.status === 409 ? 'git_actor_username_conflict' : 'git_forgejo_actor_rename_failed', `Forgejo rename failed (${response.status})`);
        username = binding.desired_username;
        user.username = username;
      }
      if (binding.state === 'ready' && binding.forgejo_user_id === Number(user.id) && binding.current_username === username) continue;
      await tower(`/actor-bindings/${encodeURIComponent(binding.actor_id)}`, {
        forgejo_user_id: Number(user.id), username, desired_username: binding.desired_username,
      });
      linked++;
    } catch (error) {
      failed++;
      try {
        await tower(`/actor-usernames/${encodeURIComponent(binding.actor_id)}/ack`, {
          desired_username: binding.desired_username, ok: false,
          error_code: error instanceof IdentityReconcilerError ? error.code : 'git_forgejo_identity_unavailable',
        });
      } catch { /* Stale requests are retried from fresh Tower state on the next poll. */ }
    }
  }
  return { processed: bindings.length, linked, failed };
}

async function main() {
  const options: IdentityReconcilerOptions = {
    towerUrl: String(process.env.GIT_GATEWAY_TOWER_URL || '').trim().replace(/\/+$/, ''),
    forgejoUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim().replace(/\/+$/, ''),
    internalToken: secretEnv('GIT_INTERNAL_SERVICE_TOKEN'), identityToken: secretEnv('GIT_FORGEJO_IDENTITY_TOKEN'),
    sourceId: Number(process.env.GIT_FORGEJO_OIDC_SOURCE_ID || 0),
  };
  if (!options.towerUrl || !options.forgejoUrl || options.internalToken.length < 32 || options.identityToken.length < 32) throw new Error('Forgejo identity reconciler is not configured');
  const once = Bun.argv.includes('--once');
  do {
    try { const result = await reconcileForgejoActorAliases(options); if (once) { console.log(JSON.stringify(result)); return; } }
    catch { if (once) throw new Error('Forgejo identity reconciliation unavailable'); }
    await Bun.sleep(5_000);
  } while (true);
}

if (import.meta.main) await main();
