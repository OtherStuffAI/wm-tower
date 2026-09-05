import type { GitForgejoOrganizationDesiredState, GitForgejoWorkspaceBinding } from '../types';
import { secretEnv } from '../secret-env';
import { ForgejoClient } from './client';

export type OrganizationReconcilerOptions = {
  towerUrl: string;
  forgejoUrl: string;
  internalToken: string;
  controlToken: string;
  webhookUrl?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
};

async function towerRequest(options: OrganizationReconcilerOptions, path: string, init: RequestInit = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.towerUrl}/api/v4/git/internal/forgejo${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-wingman-git-service-token': options.internalToken,
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Tower organization reconciliation request failed with status ${response.status}`);
  return response.json() as Promise<any>;
}

export async function reconcilePendingForgejoOrganizations(
  options: OrganizationReconcilerOptions,
): Promise<{ processed: number; reconciled: number; failed: number }> {
  const pending = await towerRequest(options, '/organizations/pending') as { organizations: GitForgejoWorkspaceBinding[] };
  const organizations = Array.isArray(pending.organizations) ? pending.organizations : [];
  const client = new ForgejoClient({
    baseUrl: options.forgejoUrl,
    controlToken: options.controlToken,
    webhookUrl: options.webhookUrl,
    webhookSecret: options.webhookSecret,
    fetchImpl: options.fetchImpl,
  });
  let reconciled = 0;
  let failed = 0;
  for (const binding of organizations) {
    let desired: GitForgejoOrganizationDesiredState | null = null;
    try {
      desired = await towerRequest(options, `/organizations/${encodeURIComponent(binding.workspace_id)}/desired-state`) as GitForgejoOrganizationDesiredState;
      await client.reconcileOrganization(desired);
      await towerRequest(options, `/organizations/${encodeURIComponent(binding.workspace_id)}/ack`, {
        method: 'POST', body: JSON.stringify({ forgejo_owner: desired.forgejo_owner, desired_generation: desired.desired_generation, ok: true }),
      });
      reconciled += 1;
    } catch (error) {
      failed += 1;
      if (desired) {
        try {
          await towerRequest(options, `/organizations/${encodeURIComponent(binding.workspace_id)}/ack`, {
            method: 'POST', body: JSON.stringify({
              forgejo_owner: desired.forgejo_owner, desired_generation: desired.desired_generation,
              ok: false,
              error_code: error instanceof Error && 'code' in error
                ? String((error as any).code) : 'forgejo_organization_reconciliation_failed',
            }),
          });
        } catch {
          // The next poll retries both Tower acknowledgement and projection.
        }
      }
    }
  }
  // Repository grants can predate the provider account. Retry from current
  // Tower authority after identity/org projection; never revoke grants to unblock it.
  const pendingRepositories = await towerRequest(options, '/repositories/pending');
  for (const repository of pendingRepositories.repositories ?? []) {
    let desired: any;
    const path = `/repositories/${encodeURIComponent(repository.repository_id)}`;
    try {
      desired = await towerRequest(options, `${path}/desired-state`);
      await client.reconcile(desired);
      await towerRequest(options, `${path}/ack`, { method: 'POST', body: JSON.stringify({ applied_policy_revision: desired.desired_policy_revision, ok: true }) });
    } catch {
      if (desired) await towerRequest(options, `${path}/ack`, { method: 'POST', body: JSON.stringify({ applied_policy_revision: desired.desired_policy_revision, ok: false, error_code: 'git_forgejo_reconciliation_failed' }) }).catch(() => {});
    }
  }
  return { processed: organizations.length, reconciled, failed };
}

async function main() {
  const options: OrganizationReconcilerOptions = {
    towerUrl: String(process.env.GIT_GATEWAY_TOWER_URL || '').trim().replace(/\/+$/, ''),
    forgejoUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim().replace(/\/+$/, ''),
    internalToken: secretEnv('GIT_INTERNAL_SERVICE_TOKEN'),
    controlToken: secretEnv('GIT_FORGEJO_CONTROL_TOKEN'),
    webhookUrl: process.env.GIT_FORGEJO_WEBHOOK_URL,
    webhookSecret: secretEnv('GIT_FORGEJO_WEBHOOK_SECRET'),
  };
  if (!options.towerUrl || !options.forgejoUrl || options.internalToken.length < 32 || options.controlToken.length < 32) {
    throw new Error('Forgejo organization reconciler is not configured');
  }
  const once = Bun.argv.includes('--once');
  do {
    try {
      const result = await reconcilePendingForgejoOrganizations(options);
      if (once) { console.log(JSON.stringify(result)); return; }
    } catch { if (once) throw new Error('Forgejo organization reconciliation unavailable'); }
    await Bun.sleep(5_000);
  } while (true);
}

if (import.meta.main) await main();
