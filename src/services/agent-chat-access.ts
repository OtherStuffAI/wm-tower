import { getDb } from '../db';
import { getWrappedKeysForMember } from './groups';
import {
  isWorkspaceUserKeyDelegationError,
  listWorkspaceKeyBindings,
  requireWorkspaceUserKeyDelegation,
} from './user-workspace-keys';

export interface RuntimeAccessIdentity {
  workspaceOwnerNpub: string | null;
  actorNpub: string;
  wsKeyNpub: string | null;
}

export interface RuntimeAccessFailure extends RuntimeAccessIdentity {
  code: 'workspace_key_missing' | 'workspace_key_revoked' | 'workspace_key_invalid' | 'group_membership_revoked';
  message: string;
  details?: Record<string, unknown>;
}

export interface GroupKeyFailure extends RuntimeAccessIdentity {
  code: 'workspace_key_revoked' | 'workspace_key_invalid' | 'group_membership_revoked' | 'group_key_missing' | 'group_key_epoch_stale';
  message: string;
  details?: Record<string, unknown>;
}

export async function diagnoseWorkspaceRuntimeAccess(
  signerNpub: string,
  userNpub: string,
  workspaceOwnerNpub: string,
): Promise<RuntimeAccessIdentity | RuntimeAccessFailure> {
  const actorNpub = userNpub;
  const wsKeyNpub = signerNpub === userNpub ? null : signerNpub;

  if (!wsKeyNpub) {
    return {
      workspaceOwnerNpub,
      actorNpub,
      wsKeyNpub: null,
    };
  }

  try {
    await requireWorkspaceUserKeyDelegation({
      userNpub: actorNpub,
      workspaceServiceNpub: workspaceOwnerNpub,
      workspaceUserKeyNpub: wsKeyNpub,
      signerNpub,
    });
  } catch (error) {
    if (!isWorkspaceUserKeyDelegationError(error)) throw error;
    return {
      workspaceOwnerNpub,
      actorNpub,
      wsKeyNpub,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (actorNpub === workspaceOwnerNpub) {
    return {
      workspaceOwnerNpub,
      actorNpub,
      wsKeyNpub,
    };
  }

  const sql = getDb();
  const [membership] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM v4_group_members gm
    JOIN v4_groups g ON g.id = gm.group_id
    WHERE g.owner_npub = ${workspaceOwnerNpub}
      AND gm.member_npub = ${actorNpub}
    LIMIT 1
  `;

  if (!membership?.ok) {
    return {
      workspaceOwnerNpub,
      actorNpub,
      wsKeyNpub,
      code: 'group_membership_revoked',
      message: 'actor is no longer a member of any readable group in this workspace',
    };
  }

  return {
    workspaceOwnerNpub,
    actorNpub,
    wsKeyNpub,
  };
}

export async function diagnoseGroupKeyRuntime(
  signerNpub: string,
  userNpub: string,
): Promise<null | GroupKeyFailure> {
  const wsKeyNpub = signerNpub === userNpub ? null : signerNpub;
  if (!wsKeyNpub) return null;

  const bindings = await listWorkspaceKeyBindings(wsKeyNpub);
  if (bindings.length === 0) {
    return {
      workspaceOwnerNpub: null,
      actorNpub: userNpub,
      wsKeyNpub,
      code: 'workspace_key_invalid',
      message: 'workspace session key is not registered',
    };
  }

  const activeBindings = bindings.filter((binding) => binding.active);
  if (activeBindings.length === 0) {
    return {
      workspaceOwnerNpub: bindings[0].workspace_owner_npub,
      actorNpub: userNpub,
      wsKeyNpub,
      code: 'workspace_key_revoked',
      message: 'workspace session key is inactive',
    };
  }

  const workspaceOwnerNpubs = [...new Set(activeBindings.map((binding) => binding.workspace_owner_npub))];
  const sql = getDb();
  const memberships = await sql<{
    group_id: string;
    workspace_owner_npub: string;
    current_epoch: number;
  }[]>`
    WITH current_epochs AS (
      SELECT DISTINCT ON (group_id)
        group_id,
        epoch
      FROM v4_group_epochs
      ORDER BY group_id, epoch DESC
    )
    SELECT
      gm.group_id,
      g.owner_npub AS workspace_owner_npub,
      ce.epoch AS current_epoch
    FROM v4_group_members gm
    JOIN v4_groups g ON g.id = gm.group_id
    JOIN current_epochs ce ON ce.group_id = gm.group_id
    WHERE gm.member_npub = ${userNpub}
      AND g.owner_npub = ANY(${workspaceOwnerNpubs})
    ORDER BY g.owner_npub, gm.group_id
  `;

  if (memberships.length === 0) {
    return {
      workspaceOwnerNpub: workspaceOwnerNpubs[0] ?? null,
      actorNpub: userNpub,
      wsKeyNpub,
      code: 'group_membership_revoked',
      message: 'actor is no longer a member of any readable group in the active workspace',
      details: {
        workspace_owner_npubs: workspaceOwnerNpubs,
      },
    };
  }

  const keys = await getWrappedKeysForMember(userNpub);
  const keysByGroupId = new Map<string, number[]>();
  for (const key of keys) {
    const existing = keysByGroupId.get(key.group_id);
    if (existing) existing.push(key.key_version);
    else keysByGroupId.set(key.group_id, [key.key_version]);
  }

  const missingGroups: Array<{ group_id: string; workspace_owner_npub: string; current_epoch: number }> = [];
  const staleGroups: Array<{ group_id: string; workspace_owner_npub: string; current_epoch: number; latest_key_version: number }> = [];

  for (const membership of memberships) {
    const keyVersions = keysByGroupId.get(membership.group_id) || [];
    if (keyVersions.length === 0) {
      missingGroups.push(membership);
      continue;
    }
    if (!keyVersions.includes(membership.current_epoch)) {
      staleGroups.push({
        ...membership,
        latest_key_version: Math.max(...keyVersions),
      });
    }
  }

  if (missingGroups.length > 0) {
    return {
      workspaceOwnerNpub: missingGroups[0].workspace_owner_npub,
      actorNpub: userNpub,
      wsKeyNpub,
      code: 'group_key_missing',
      message: 'missing wrapped group keys for one or more current memberships',
      details: {
        missing_groups: missingGroups,
      },
    };
  }

  if (staleGroups.length > 0) {
    return {
      workspaceOwnerNpub: staleGroups[0].workspace_owner_npub,
      actorNpub: userNpub,
      wsKeyNpub,
      code: 'group_key_epoch_stale',
      message: 'wrapped group keys do not cover the current epoch for one or more memberships',
      details: {
        stale_groups: staleGroups,
      },
    };
  }

  return null;
}
