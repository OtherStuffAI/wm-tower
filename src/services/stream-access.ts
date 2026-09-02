/**
 * Phase 1 actor-visible SSE access resolution.
 *
 * Authorization rule for /api/v4/workspaces/:ownerNpub/stream:
 *   1. Allow if the resolved actor identity equals the workspace owner npub.
 *   2. Otherwise, allow only if BOTH:
 *      a. The signing npub is registered as an active ws_key_npub bound to
 *         that workspace_owner_npub, AND
 *      b. The resolved actor is a current member of at least one active
 *         readable group owned by that workspace owner.
 *   3. Reject otherwise.
 */
import { resolveWsKeyNpub } from './user-workspace-keys';
import { diagnoseWorkspaceRuntimeAccess } from './agent-chat-access';

export type StreamAccessReason =
  | 'not_owner_no_ws_key'
  | 'ws_key_not_for_workspace'
  | 'no_group_membership';

export type StreamAccessResult =
  | {
      ok: true;
      ownerNpub: string;
      actorNpub: string;
      wsKeyNpub: string | null;
    }
  | {
      ok: false;
      ownerNpub: string;
      actorNpub: string;
      wsKeyNpub: string | null;
      reason: StreamAccessReason;
      reasonCode:
        | 'workspace_key_missing'
        | 'workspace_key_invalid'
        | 'workspace_key_revoked'
        | 'group_membership_revoked';
    };

export async function resolveStreamAccess(
  signerNpub: string,
  ownerNpub: string,
): Promise<StreamAccessResult> {
  const resolvedUser = await resolveWsKeyNpub(signerNpub);
  const actorNpub = resolvedUser ?? signerNpub;
  const wsKeyNpub = resolvedUser ? signerNpub : null;

  if (actorNpub === ownerNpub && wsKeyNpub === null) {
    return { ok: true, ownerNpub, actorNpub, wsKeyNpub: null };
  }

  if (actorNpub !== ownerNpub && wsKeyNpub === null) {
    return {
      ok: false,
      ownerNpub,
      actorNpub,
      wsKeyNpub: null,
      reason: 'not_owner_no_ws_key',
      reasonCode: 'workspace_key_missing',
    };
  }

  const diagnosed = await diagnoseWorkspaceRuntimeAccess(signerNpub, actorNpub, ownerNpub);
  if ('code' in diagnosed) {
    return {
      ok: false,
      ownerNpub,
      actorNpub: diagnosed.actorNpub,
      wsKeyNpub: diagnosed.wsKeyNpub,
      reason: diagnosed.code === 'group_membership_revoked' ? 'no_group_membership' : 'ws_key_not_for_workspace',
      reasonCode: diagnosed.code,
    };
  }

  return {
    ok: true,
    ownerNpub,
    actorNpub: diagnosed.actorNpub,
    wsKeyNpub: diagnosed.wsKeyNpub,
  };
}
