import { secretEnv } from '../secret-env';

type ActorBinding = { actor_id: string; current_username: string; forgejo_user_id: number | null };
type IdentityReconcilerOptions = { towerUrl: string; forgejoUrl: string; internalToken: string; identityToken: string; fetchImpl?: typeof fetch };

export class IdentityReconcilerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export async function reconcileForgejoActorAliases(options: IdentityReconcilerOptions): Promise<{ processed: number; linked: number; failed: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const bindingsResponse = await fetchImpl(`${options.towerUrl}/api/v4/git/internal/forgejo/actor-bindings`, { headers: { 'x-wingman-git-service-token': options.internalToken, accept: 'application/json' } });
  if (!bindingsResponse.ok) throw new IdentityReconcilerError('git_actor_binding_list_failed', `Tower actor binding lookup failed with status ${bindingsResponse.status}`);
  const bindings = ((await bindingsResponse.json() as any).actor_bindings || []) as ActorBinding[];
  const usersResponse = await fetchImpl(`${options.forgejoUrl}/api/v1/admin/users?limit=1000`, { headers: { authorization: `token ${options.identityToken}`, accept: 'application/json' } });
  if (!usersResponse.ok) throw new IdentityReconcilerError('git_forgejo_actor_lookup_failed', `Forgejo account lookup failed with status ${usersResponse.status}`);
  const users = await usersResponse.json() as any[];
  if (!Array.isArray(users)) throw new IdentityReconcilerError('git_forgejo_actor_lookup_invalid', 'Forgejo returned an invalid account list');
  let linked = 0, failed = 0;
  for (const binding of bindings) {
    try {
      // New OIDC users expose the Tower actor UUID as login_name. Existing
      // reverse-proxy users are bound once by their unique migration username;
      // after that the immutable numeric Forgejo user ID follows every rename.
      const user = binding.forgejo_user_id
        ? users.find((candidate) => Number(candidate?.id) === binding.forgejo_user_id)
        : users.find((candidate) => String(candidate?.login_name || '') === binding.actor_id
          || String(candidate?.username || candidate?.login || '') === binding.current_username);
      if (!user) continue; // The actor has not completed their first OIDC login yet.
      const username = String(user.username || user.login || '');
      if (!Number.isSafeInteger(Number(user.id)) || !username) throw new IdentityReconcilerError('git_forgejo_actor_lookup_invalid', 'Forgejo returned an invalid external account');
      if (binding.forgejo_user_id === Number(user.id) && binding.current_username === username) continue;
      const sync = await fetchImpl(`${options.towerUrl}/api/v4/git/internal/forgejo/actor-bindings/${encodeURIComponent(binding.actor_id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wingman-git-service-token': options.internalToken },
        body: JSON.stringify({ forgejo_user_id: Number(user.id), username }),
      });
      if (!sync.ok) throw new IdentityReconcilerError('git_actor_binding_sync_failed', `Tower actor binding sync failed with status ${sync.status}`);
      linked += 1;
    } catch { failed += 1; }
  }
  return { processed: bindings.length, linked, failed };
}

async function main() {
  const options: IdentityReconcilerOptions = {
    towerUrl: String(process.env.GIT_GATEWAY_TOWER_URL || '').trim().replace(/\/+$/, ''),
    forgejoUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim().replace(/\/+$/, ''),
    internalToken: secretEnv('GIT_INTERNAL_SERVICE_TOKEN'), identityToken: secretEnv('GIT_FORGEJO_IDENTITY_TOKEN'),
  };
  if (!options.towerUrl || !options.forgejoUrl || options.internalToken.length < 32 || options.identityToken.length < 32) throw new Error('Forgejo identity reconciler is not configured');
  const once = Bun.argv.includes('--once');
  do { const result = await reconcileForgejoActorAliases(options); if (once) { console.log(JSON.stringify(result)); return; } await Bun.sleep(5_000); } while (true);
}

if (import.meta.main) await main();
