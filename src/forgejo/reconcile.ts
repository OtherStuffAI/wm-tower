import type { GitForgejoDesiredState } from '../types';
import { secretEnv } from '../secret-env';
import { ForgejoClient } from './client';

const runtime = {
  towerUrl: String(process.env.GIT_GATEWAY_TOWER_URL || '').trim().replace(/\/+$/, ''),
  forgejoUrl: String(process.env.GIT_FORGEJO_BASE_URL || '').trim().replace(/\/+$/, ''),
  internalServiceToken: secretEnv('GIT_INTERNAL_SERVICE_TOKEN'),
  controlToken: secretEnv('GIT_FORGEJO_CONTROL_TOKEN'),
  webhookUrl: String(process.env.GIT_FORGEJO_WEBHOOK_URL || '').trim(),
  webhookSecret: secretEnv('GIT_FORGEJO_WEBHOOK_SECRET'),
};

async function towerRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${runtime.towerUrl}/api/v4/git/internal/forgejo${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-wingman-git-service-token': runtime.internalServiceToken,
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Tower Git reconciliation request failed with status ${response.status}`);
  return response.json() as Promise<any>;
}

export async function reconcileForgejoRepository(repositoryId: string) {
  if (!runtime.towerUrl || runtime.internalServiceToken.length < 32) throw new Error('Tower Git reconciliation is not configured');
  const state = await towerRequest(`/repositories/${encodeURIComponent(repositoryId)}/desired-state`) as GitForgejoDesiredState;
  const client = new ForgejoClient({
    baseUrl: runtime.forgejoUrl,
    controlToken: runtime.controlToken,
    webhookUrl: runtime.webhookUrl,
    webhookSecret: runtime.webhookSecret,
  });
  try {
    await client.reconcile(state);
    return await towerRequest(`/repositories/${encodeURIComponent(repositoryId)}/ack`, {
      method: 'POST', body: JSON.stringify({ applied_policy_revision: state.desired_policy_revision, ok: true }),
    });
  } catch (error) {
    await towerRequest(`/repositories/${encodeURIComponent(repositoryId)}/ack`, {
      method: 'POST', body: JSON.stringify({
        applied_policy_revision: state.desired_policy_revision,
        ok: false,
        error_code: error instanceof Error && 'code' in error ? String((error as any).code) : 'forgejo_reconciliation_failed',
      }),
    });
    throw error;
  }
}

if (import.meta.main) {
  const repositoryId = process.argv[2];
  if (!repositoryId) throw new Error('Usage: bun run src/forgejo/reconcile.ts <repository-id>');
  await reconcileForgejoRepository(repositoryId);
  console.log('Forgejo reconciliation complete');
}
