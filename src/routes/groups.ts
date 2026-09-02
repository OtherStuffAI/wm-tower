import { Hono } from 'hono';
import { jsonAgentChatError } from '../agent-chat-errors';
import { createGroup, addGroupMember, rotateGroupEpoch, removeGroupMember, getGroupById, getCurrentGroupEpoch, listGroupsForNpub, deleteGroup, updateGroupName, getWrappedKeysForMember, listGroupMemberNpubs } from '../services/groups';
import { diagnoseGroupKeyRuntime } from '../services/agent-chat-access';
import { areWorkspaceGroupMembers, canCreateWorkspaceGroup, canManageWorkspace } from '../services/workspaces';
import { requireNip98AuthResolved } from '../auth';
import {
  identityNormalizationErrorBody,
  isIdentityNormalizationError,
  normalizeWorkspaceServiceNpub,
} from '../identity-normalization';
import { sseHub } from '../sse-hub';
import type { CreateGroupInput, AddMemberInput, RotateGroupEpochInput, UpdateGroupInput } from '../types';

export const groupsRouter = new Hono();

function isProtectedSystemGroupKind(groupKind: string | null | undefined): boolean {
  return ['workspace_shared', 'workspace_admin', 'private'].includes(String(groupKind || '').trim());
}

function hasDuplicateMembers(memberNpubs: string[]): boolean {
  return new Set(memberNpubs).size !== memberNpubs.length;
}

// POST /api/v4/groups
groupsRouter.post('/', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const body = await c.req.json<CreateGroupInput>();

  let workspaceServiceNpub: string | undefined;
  try {
    workspaceServiceNpub = normalizeWorkspaceServiceNpub(body as unknown as Record<string, unknown>);
  } catch (error) {
    if (isIdentityNormalizationError(error)) {
      return c.json(identityNormalizationErrorBody(error), 400);
    }
    throw error;
  }

  if (!workspaceServiceNpub || !body.name) {
    return c.json({ error: 'owner_npub or workspace_service_npub, and name required' }, 400);
  }
  if (!body.group_npub) {
    return c.json({ error: 'group_npub required' }, 400);
  }
  if (body.group_kind && body.group_kind !== 'shared') {
    return c.json({ error: 'group_kind is reserved for system-managed groups' }, 400);
  }
  if (!body.member_keys || !Array.isArray(body.member_keys) || body.member_keys.length === 0) {
    return c.json({ error: 'member_keys array required and must not be empty' }, 400);
  }
  if (!(await canCreateWorkspaceGroup(workspaceServiceNpub, userNpub))) {
    return c.json({ error: 'owner_npub must match authenticated npub or a managed workspace' }, 403);
  }

  // Validate each member key entry
  for (const mk of body.member_keys) {
    if (!mk.member_npub || !mk.wrapped_group_nsec || !mk.wrapped_by_npub) {
      return c.json({ error: 'each member_keys entry must have member_npub, wrapped_group_nsec, and wrapped_by_npub' }, 400);
    }
  }
  if (hasDuplicateMembers(body.member_keys.map((mk) => mk.member_npub))) {
    return c.json({ error: 'member_keys must contain unique member_npub values' }, 400);
  }

  const requiredHolderHasKey = body.member_keys.some((mk) => mk.member_npub === userNpub);
  if (!requiredHolderHasKey) {
    return c.json({ error: 'group creator must have a wrapped key in member_keys' }, 400);
  }

  const actorCanManageWorkspace = await canManageWorkspace(workspaceServiceNpub, userNpub);
  if (!actorCanManageWorkspace) {
    const allMembersBelongToWorkspace = await areWorkspaceGroupMembers(
      workspaceServiceNpub,
      body.member_keys.map((mk) => mk.member_npub),
    );
    if (!allMembersBelongToWorkspace) {
      return c.json({ error: 'member_keys may only include existing workspace members' }, 403);
    }
  }

  try {
    const normalizedBody = {
      ...body,
      owner_npub: workspaceServiceNpub,
    };
    const { group, members } = await createGroup(normalizedBody, userNpub);
    return c.json({
      group_id: group.id,
      group_npub: group.group_npub,
      current_epoch: 1,
      owner_npub: group.owner_npub,
      workspace_service_npub: group.owner_npub,
      name: group.name,
      group_kind: group.group_kind,
      private_member_npub: group.private_member_npub,
      members: members.map((m) => ({ id: m.id, member_npub: m.member_npub })),
      created_at: group.created_at,
    }, 201);
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return c.json({ error: 'group_npub already exists' }, 409);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Failed to create group' }, 500);
  }
});

// POST /api/v4/groups/:groupId/rotate
groupsRouter.post('/:groupId/rotate', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const groupId = c.req.param('groupId');
  const body = await c.req.json<RotateGroupEpochInput>();

  if (!body.group_npub) {
    return c.json({ error: 'group_npub required' }, 400);
  }
  if (!body.member_keys || !Array.isArray(body.member_keys) || body.member_keys.length === 0) {
    return c.json({ error: 'member_keys array required and must not be empty' }, 400);
  }
  for (const mk of body.member_keys) {
    if (!mk.member_npub || !mk.wrapped_group_nsec || !mk.wrapped_by_npub) {
      return c.json({ error: 'each member_keys entry must have member_npub, wrapped_group_nsec, and wrapped_by_npub' }, 400);
    }
  }
  if (hasDuplicateMembers(body.member_keys.map((mk) => mk.member_npub))) {
    return c.json({ error: 'member_keys must contain unique member_npub values' }, 400);
  }

  try {
    const group = await getGroupById(groupId);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!(await canManageWorkspace(group.owner_npub, userNpub))) {
      return c.json({ error: 'Only the group owner can rotate groups' }, 403);
    }

    const result = await rotateGroupEpoch(groupId, body, userNpub);
    sseHub.emit(result.group.owner_npub, {
      event: 'group-changed',
      data: { group_id: groupId, group_npub: result.group.group_npub, action: 'epoch_rotated' },
    }, {
      visibleToUserNpubs: result.members.map((member) => member.member_npub),
    });
    return c.json({
      group_id: result.group.id,
      group_npub: result.group.group_npub,
      current_epoch: result.epoch.epoch,
      owner_npub: result.group.owner_npub,
      name: result.group.name,
      group_kind: result.group.group_kind,
      private_member_npub: result.group.private_member_npub,
      members: result.members.map((member) => ({ id: member.id, member_npub: member.member_npub })),
      created_at: result.group.created_at,
    });
  } catch (error) {
    if (error instanceof Error && /duplicate key value/i.test(error.message)) {
      return c.json({ error: 'group_npub already exists' }, 409);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Failed to rotate group epoch' }, 500);
  }
});

// POST /api/v4/groups/:groupId/members
groupsRouter.post('/:groupId/members', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const groupId = c.req.param('groupId');
  const body = await c.req.json<AddMemberInput>();

  if (!body.member_npub || !body.wrapped_group_nsec || !body.wrapped_by_npub) {
    return c.json({ error: 'member_npub, wrapped_group_nsec, and wrapped_by_npub required' }, 400);
  }

  try {
    const group = await getGroupById(groupId);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!(await canManageWorkspace(group.owner_npub, userNpub))) {
      return c.json({ error: 'Only the group owner can add members' }, 403);
    }

    const { member, key } = await addGroupMember(groupId, body, userNpub);
    const visibleToUserNpubs = await listGroupMemberNpubs(groupId);
    sseHub.emit(group.owner_npub, {
      event: 'group-changed',
      data: { group_id: groupId, group_npub: group.group_npub, action: 'member_added' },
    }, {
      visibleToUserNpubs,
    });
    return c.json({
      id: member.id,
      group_id: member.group_id,
      member_npub: member.member_npub,
      wrapped_group_nsec: key.wrapped_group_nsec,
      wrapped_by_npub: key.wrapped_by_npub,
      approved_by_npub: key.approved_by_npub,
      key_version: key.key_version,
      created_at: member.created_at,
    }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'Group not found') {
      return c.json({ error: 'Group not found' }, 404);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Failed to add member' }, 500);
  }
});

// DELETE /api/v4/groups/:groupId/members/:memberNpub
groupsRouter.delete('/:groupId/members/:memberNpub', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const groupId = c.req.param('groupId');
  const memberNpub = c.req.param('memberNpub');

  try {
    const group = await getGroupById(groupId);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (!(await canManageWorkspace(group.owner_npub, userNpub))) {
      return c.json({ error: 'Only the group owner can remove members' }, 403);
    }

    const removed = await removeGroupMember(groupId, memberNpub);
    if (!removed) {
      return c.json({ error: 'Member not found' }, 404);
    }

    const visibleToUserNpubs = await listGroupMemberNpubs(groupId);
    sseHub.emit(group.owner_npub, {
      event: 'group-changed',
      data: { group_id: groupId, group_npub: group.group_npub, action: 'member_removed' },
    }, {
      visibleToUserNpubs,
    });
    return c.json({ ok: true, group_id: groupId, member_npub: memberNpub });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to remove member' }, 500);
  }
});

// GET /api/v4/groups/keys?member_npub=<npub>
groupsRouter.get('/keys', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  const memberNpub = c.req.query('member_npub');
  if (!memberNpub) {
    return c.json({ error: 'member_npub query param required' }, 400);
  }
  // Accept member_npub matching either the signer or resolved user identity
  if (memberNpub !== signerNpub && memberNpub !== userNpub) {
    return c.json({ error: 'member_npub must match authenticated npub' }, 403);
  }

  try {
    const runtimeFailure = await diagnoseGroupKeyRuntime(signerNpub, userNpub);
    if (runtimeFailure) {
      return jsonAgentChatError(
        c,
        runtimeFailure.code === 'group_key_missing' || runtimeFailure.code === 'group_key_epoch_stale' ? 409 : 403,
        runtimeFailure.code,
        runtimeFailure.message,
        {
          workspace_owner_npub: runtimeFailure.workspaceOwnerNpub,
          actor_npub: runtimeFailure.actorNpub,
          ws_key_npub: runtimeFailure.wsKeyNpub,
          details: runtimeFailure.details,
        },
      );
    }

    // Group membership is stored by real user npub
    const keys = await getWrappedKeysForMember(userNpub);

    return c.json({ keys });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to fetch keys' }, 500);
  }
});

// GET /api/v4/groups?npub=<npub>
groupsRouter.get('/', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { signerNpub, userNpub } = auth;

  const npub = c.req.query('npub') || c.req.query('owner_npub');
  if (!npub) {
    return c.json({ error: 'npub query param required' }, 400);
  }
  // Accept npub matching either the signer or resolved user identity
  if (npub !== signerNpub && npub !== userNpub) {
    return c.json({ error: 'npub must match authenticated npub' }, 403);
  }

  try {
    // Query by real user npub for group ownership/membership lookups
    const groups = await listGroupsForNpub(userNpub);
    return c.json({ groups });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to list groups' }, 500);
  }
});

// DELETE /api/v4/groups/:groupId
groupsRouter.delete('/:groupId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const groupId = c.req.param('groupId');

  try {
    const group = await getGroupById(groupId);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (isProtectedSystemGroupKind(group.group_kind)) {
      return c.json({ error: 'Protected system groups cannot be deleted' }, 403);
    }
    if (!(await canManageWorkspace(group.owner_npub, userNpub))) {
      return c.json({ error: 'Only the group owner can delete groups' }, 403);
    }

    await deleteGroup(groupId);
    return c.json({ ok: true, group_id: groupId });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to delete group' }, 500);
  }
});

// PATCH /api/v4/groups/:groupId
groupsRouter.patch('/:groupId', async (c) => {
  const auth = await requireNip98AuthResolved(c);
  if (auth instanceof Response) return auth;
  const { userNpub } = auth;

  const groupId = c.req.param('groupId');
  const body = await c.req.json<UpdateGroupInput>();
  const name = String(body?.name || '').trim();

  if (!name) {
    return c.json({ error: 'name required' }, 400);
  }

  try {
    const group = await getGroupById(groupId);
    if (!group) {
      return c.json({ error: 'Group not found' }, 404);
    }
    if (isProtectedSystemGroupKind(group.group_kind)) {
      return c.json({ error: 'Protected system groups cannot be renamed' }, 403);
    }
    if (!(await canManageWorkspace(group.owner_npub, userNpub))) {
      return c.json({ error: 'Only the group owner can rename groups' }, 403);
    }

    const updated = await updateGroupName(groupId, name);
    if (!updated) {
      return c.json({ error: 'Group not found' }, 404);
    }

    const currentEpoch = await getCurrentGroupEpoch(groupId);

    return c.json({
      group_id: updated.id,
      group_npub: updated.group_npub,
      current_epoch: currentEpoch?.epoch ?? 1,
      owner_npub: updated.owner_npub,
      name: updated.name,
      group_kind: updated.group_kind,
      private_member_npub: updated.private_member_npub,
      created_at: updated.created_at,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to rename group' }, 500);
  }
});
